import { LatencyHistogram } from './histogram';

export type LtapScenario = 'cdf-freshness' | 'sync-serving' | 'ltap-closed-loop' | 'telemetry-diagnosis';

export interface LtapRunConfig {
  scenario: LtapScenario;
  durationSeconds: number;
  warmupSeconds: number;
}

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface AnalyticsClient {
  query(statement: string): Promise<unknown>;
  queryRows(statement: string): Promise<Record<string, unknown>[]>;
}

type Boundary = 'idle' | 'postgres-to-delta' | 'analytics' | 'delta-to-postgres';

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class LtapEngine {
  private active: { id: string; cancelled: boolean; startedAt: number; success: number; errors: number } | null = null;
  private histogram = new LatencyHistogram();
  private boundary: Boundary = 'idle';
  private boundaryStartedAt = 0;
  private pgToDeltaMs = 0;
  private analyticsMs = 0;
  private deltaToPgMs = 0;
  private lastMetricAt = 0;
  private recording = false;

  constructor(
    private readonly target: Queryable,
    private readonly control: Queryable,
    private readonly analytics: AnalyticsClient,
    private readonly namespace: () => string,
    private readonly cdfTable: () => string,
    private readonly syncedTable = 'lakeload_sync.serving_profile'
  ) {}

  get activeRunId() {
    return this.active?.id ?? null;
  }

  cancel(runId: string) {
    if (this.active?.id !== runId) return false;
    this.active.cancelled = true;
    return true;
  }

  async start(runId: string, config: LtapRunConfig) {
    if (this.active) throw new Error('An LTAP test is already running');
    const startedAt = Date.now();
    this.active = { id: runId, cancelled: false, startedAt, success: 0, errors: 0 };
    this.histogram.reset();
    this.lastMetricAt = startedAt;
    await this.control.query(
      `UPDATE lakeload_control.run SET status='running',started_at=NOW(),measurement_started_at=NOW() WHERE id=$1`,
      [runId]
    );
    const heartbeat = setInterval(() => void this.recordMetric(runId, 0), 1_000);
    const endAt = startedAt + config.durationSeconds * 1_000;
    let sequence = 0;
    try {
      while (Date.now() < endAt && this.active && !this.active.cancelled) {
        const minimumCycleBudget = config.scenario === 'ltap-closed-loop' ? 40_000 : 20_000;
        if (this.active.success > 0 && endAt - Date.now() < minimumCycleBudget) break;
        sequence += 1;
        this.resetBoundaries();
        const totalStarted = performance.now();
        if (config.scenario === 'cdf-freshness') await this.runCdfCycle(runId, sequence, endAt);
        else if (config.scenario === 'sync-serving') await this.runSyncCycle(runId, sequence, endAt);
        else if (config.scenario === 'telemetry-diagnosis') await this.runTelemetryCycle(runId, sequence, endAt);
        else await this.runClosedLoop(runId, sequence, endAt);
        const totalMs = performance.now() - totalStarted;
        this.histogram.observe(totalMs);
        if (this.active) this.active.success += 1;
        await this.recordMetric(runId, 1, totalMs);
      }
      const snapshot = this.histogram.snapshot();
      const status = this.active?.cancelled ? 'cancelled' : 'completed';
      await this.control.query(
        `UPDATE lakeload_control.run SET status=$2,completed_at=NOW(),total_operations=$3,total_errors=$4,
         p50_ms=$5,p95_ms=$6,p99_ms=$7,query_errors=$4 WHERE id=$1`,
        [runId, status, this.active?.success ?? 0, this.active?.errors ?? 0, snapshot.p50Ms, snapshot.p95Ms, snapshot.p99Ms]
      );
    } catch (error) {
      if (this.active) this.active.errors += 1;
      const snapshot = this.histogram.snapshot();
      await this.control.query(
        `UPDATE lakeload_control.run SET status='failed',completed_at=NOW(),total_operations=$2,total_errors=$3,
         query_errors=$3,p50_ms=$4,p95_ms=$5,p99_ms=$6,error_message=$7 WHERE id=$1`,
        [
          runId,
          this.active?.success ?? 0,
          this.active?.errors ?? 1,
          snapshot.p50Ms,
          snapshot.p95Ms,
          snapshot.p99Ms,
          error instanceof Error ? error.message : String(error),
        ]
      );
      throw error;
    } finally {
      clearInterval(heartbeat);
      this.active = null;
      this.resetBoundaries();
    }
  }

  private async runCdfCycle(runId: string, sequence: number, endAt: number) {
    const tag = `${runId}:${sequence}`;
    const inserted = await this.target.query(
      `INSERT INTO lakeload_bench.orders(account_id,status,total,run_tag)
       VALUES($1,'created',$2,$3) RETURNING id`,
      [1 + (sequence % 1_000_000), 100 + (sequence % 100), tag]
    );
    const id = inserted.rows[0]?.id;
    await this.target.query(`UPDATE lakeload_bench.orders SET status='confirmed' WHERE id=$1`, [id]);
    await this.target.query(`DELETE FROM lakeload_bench.orders WHERE id=$1`, [id]);
    this.beginBoundary('postgres-to-delta');
    await this.pollUntil(endAt, async () => {
      const rows = await this.analytics.queryRows(
        `SELECT COUNT(DISTINCT _pg_change_type) AS found FROM ${this.cdfTable()}
         WHERE run_tag='${sqlLiteral(tag)}'
           AND _pg_change_type IN ('insert','update_preimage','update_postimage','delete')`
      );
      return Number(rows[0]?.found ?? 0) >= 4;
    }, 'CDF did not expose the insert, update before/after images, and delete before the run deadline');
    this.pgToDeltaMs = this.endBoundary();
  }

  private async runSyncCycle(runId: string, sequence: number, endAt: number) {
    const profileId = 1 + (sequence % 100);
    const token = `${runId.slice(0, 8)}-${sequence}-${Date.now()}`;
    this.beginBoundary('delta-to-postgres');
    await this.analytics.query(
      `MERGE INTO ${this.namespace()}.lakeload_serving_profile t
       USING (SELECT ${profileId} AS id,'preview' AS segment,${sequence % 100} AS score,
                     '${sqlLiteral(token)}' AS version_token,current_timestamp() AS updated_at) s
       ON t.id=s.id WHEN MATCHED THEN UPDATE SET * WHEN NOT MATCHED THEN INSERT *`
    );
    await this.pollUntil(endAt, async () => {
      const result = await this.target.query(
        `SELECT 1 FROM ${this.syncedTable} WHERE id=$1 AND version_token=$2 LIMIT 1`,
        [profileId, token]
      );
      return result.rows.length > 0;
    }, 'The Delta update did not reach the Lakebase synced table before the run deadline');
    this.deltaToPgMs = this.endBoundary();
  }

  private async runClosedLoop(runId: string, sequence: number, endAt: number) {
    const tag = `${runId}:${sequence}`;
    const accountId = 1 + (sequence % 100);
    const total = 100 + (sequence % 100);
    await this.target.query(
      `INSERT INTO lakeload_bench.orders(account_id,status,total,run_tag) VALUES($1,'created',$2,$3)`,
      [accountId, total, tag]
    );
    this.beginBoundary('postgres-to-delta');
    await this.pollUntil(endAt, async () => {
      const rows = await this.analytics.queryRows(
        `SELECT COUNT(*) AS found FROM ${this.cdfTable()}
         WHERE run_tag='${sqlLiteral(tag)}' AND _pg_change_type='insert'`
      );
      return Number(rows[0]?.found ?? 0) > 0;
    }, 'The committed order did not reach Delta before the run deadline');
    this.pgToDeltaMs = this.endBoundary();

    this.beginBoundary('analytics');
    const token = `${runId.slice(0, 8)}-${sequence}-${Date.now()}`;
    await this.analytics.query(
      `MERGE INTO ${this.namespace()}.lakeload_serving_profile t
       USING (SELECT ${accountId} AS id,'cdf-enriched' AS segment,CAST(${total} % 100 AS INT) AS score,
                     '${sqlLiteral(token)}' AS version_token,current_timestamp() AS updated_at) s
       ON t.id=s.id WHEN MATCHED THEN UPDATE SET * WHEN NOT MATCHED THEN INSERT *`
    );
    this.analyticsMs = this.endBoundary();

    this.beginBoundary('delta-to-postgres');
    await this.pollUntil(endAt, async () => {
      const result = await this.target.query(
        `SELECT 1 FROM ${this.syncedTable} WHERE id=$1 AND version_token=$2 LIMIT 1`,
        [accountId, token]
      );
      return result.rows.length > 0;
    }, 'The enriched profile did not return through the synced table before the run deadline');
    this.deltaToPgMs = this.endBoundary();
  }

  private async runTelemetryCycle(runId: string, sequence: number, endAt: number) {
    const marker = `lakeload_telemetry_probe_${runId.replace(/-/g, '_')}_${sequence}`;
    await this.target.query(`SELECT COUNT(*)::bigint AS rows_seen FROM lakeload_bench.account /* ${marker} */`);
    this.beginBoundary('analytics');
    await this.pollUntil(endAt, async () => {
      const rows = await this.analytics.queryRows(
        `SELECT COUNT(*) AS found FROM ${this.namespace()}.pg_stat_statements_counters
         WHERE ts >= current_timestamp() - INTERVAL 10 MINUTES AND query LIKE '%${marker}%'`
      );
      return Number(rows[0]?.found ?? 0) > 0;
    }, 'The tagged query did not appear in advanced Postgres telemetry before the run deadline');
    this.analyticsMs = this.endBoundary();
  }

  private async pollUntil(endAt: number, check: () => Promise<boolean>, timeoutMessage: string) {
    while (Date.now() < endAt && this.active && !this.active.cancelled) {
      if (await check()) return;
      await pause(1_000);
    }
    if (this.active?.cancelled) return;
    throw new Error(timeoutMessage);
  }

  private beginBoundary(boundary: Boundary) {
    this.boundary = boundary;
    this.boundaryStartedAt = performance.now();
  }

  private endBoundary() {
    const elapsed = performance.now() - this.boundaryStartedAt;
    this.boundary = 'idle';
    return elapsed;
  }

  private resetBoundaries() {
    this.boundary = 'idle';
    this.boundaryStartedAt = 0;
    this.pgToDeltaMs = 0;
    this.analyticsMs = 0;
    this.deltaToPgMs = 0;
  }

  private async recordMetric(runId: string, operations: number, completedMs = 0) {
    if (this.recording || !this.active || this.active.id !== runId) return;
    this.recording = true;
    try {
      const now = Date.now();
      const intervalMs = Math.max(1, now - this.lastMetricAt);
      this.lastMetricAt = now;
      const liveElapsed = this.boundary === 'idle' ? 0 : performance.now() - this.boundaryStartedAt;
      const pgToDelta = this.boundary === 'postgres-to-delta' ? liveElapsed : this.pgToDeltaMs;
      const analytics = this.boundary === 'analytics' ? liveElapsed : this.analyticsMs;
      const deltaToPg = this.boundary === 'delta-to-postgres' ? liveElapsed : this.deltaToPgMs;
      const total = completedMs || pgToDelta + analytics + deltaToPg;
      await this.control.query(
        `INSERT INTO lakeload_control.run_metric
         (run_id,elapsed_seconds,active_users,operations,errors,reads,writes,complex_queries,
          p50_ms,p95_ms,p99_ms,histogram,interval_ms,throughput_rps,offered,dropped,query_errors,
          mean_ms,max_ms,phase,target_rps,feature_stage,pg_to_delta_ms,analytics_ms,delta_to_pg_ms)
         VALUES($1,$2,1,$3,0,0,$3,0,$4,$4,$4,'{}'::jsonb,$5,$6,$3,0,0,$4,$4,'measure',$6,$7,$8,$9,$10)`,
        [
          runId,
          Math.max(0, Math.round((now - this.active.startedAt) / 1_000)),
          operations,
          total,
          intervalMs,
          (operations * 1_000) / intervalMs,
          this.boundary,
          pgToDelta,
          analytics,
          deltaToPg,
        ]
      );
    } finally {
      this.recording = false;
    }
  }
}

function sqlLiteral(value: string) {
  return value.replace(/'/g, "''");
}
