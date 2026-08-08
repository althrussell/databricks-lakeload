import { randomInt } from 'node:crypto';
import { LatencyHistogram } from './histogram';

export type Scenario = 'lakebase-point-lookup' | 'lakebase-transfer' | 'lakebase-mixed' | 'lakebase-operational-join';

export interface RunConfig {
  scenario: Scenario;
  concurrency: number;
  durationSeconds: number;
  rampSeconds: number;
  executionModel: 'closed' | 'open';
  targetRps?: number;
}

interface ControlDatabase {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TargetClient {
  query(text: string, params?: unknown[]): Promise<unknown>;
  release(): void;
}

interface TargetPool {
  query(text: string, params?: unknown[]): Promise<unknown>;
  connect(): Promise<TargetClient>;
}

interface ActiveRun {
  id: string;
  cancelled: boolean;
  startedAt: number;
  totalSuccess: number;
  totalErrors: number;
  activeUsers: number;
}

interface IntervalCounters {
  success: number;
  errors: number;
  reads: number;
  writes: number;
  complex: number;
}

interface DatabaseStats {
  commits: number;
  rollbacks: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsDeleted: number;
  connectionsActive: number;
  connectionsIdle: number;
  connectionsTotal: number;
  locksWaiting: number;
  locksTotal: number;
  cacheHitPct: number;
  databaseBytes: number;
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class LoadEngine {
  private activeRun: ActiveRun | null = null;
  private histogram = new LatencyHistogram();
  private overallHistogram = new LatencyHistogram();
  private interval: IntervalCounters = { success: 0, errors: 0, reads: 0, writes: 0, complex: 0 };
  private previousDatabaseStats: DatabaseStats | null = null;
  private flushing = false;

  constructor(
    private readonly target: TargetPool,
    private readonly control: ControlDatabase
  ) {}

  get activeRunId() {
    return this.activeRun?.id ?? null;
  }

  cancel(runId: string) {
    if (this.activeRun?.id !== runId) return false;
    this.activeRun.cancelled = true;
    return true;
  }

  async start(runId: string, config: RunConfig) {
    if (this.activeRun) throw new Error('A load test is already running');
    this.activeRun = {
      id: runId,
      cancelled: false,
      startedAt: Date.now(),
      totalSuccess: 0,
      totalErrors: 0,
      activeUsers: 0,
    };
    this.histogram.reset();
    this.overallHistogram.reset();
    this.interval = { success: 0, errors: 0, reads: 0, writes: 0, complex: 0 };
    this.previousDatabaseStats = await this.databaseStats();

    const endAt = Date.now() + config.durationSeconds * 1000;
    await this.control.query(`UPDATE lakeload_control.run SET status = 'running', started_at = NOW() WHERE id = $1`, [
      runId,
    ]);

    const metricTimer = setInterval(() => {
      void this.flushMetric(runId);
    }, 1000);

    try {
      if (config.executionModel === 'open') {
        await this.openLoop(endAt, config);
      } else {
        const workers = Array.from({ length: config.concurrency }, (_, index) => this.worker(index, endAt, config));
        await Promise.all(workers);
      }
      await this.flushMetric(runId);

      const active = this.activeRun;
      const finalHistogram = this.overallHistogram.snapshot();
      const status = active?.cancelled ? 'cancelled' : 'completed';
      await this.control.query(
        `UPDATE lakeload_control.run
         SET status = $2, completed_at = NOW(), total_operations = $3,
             total_errors = $4, p50_ms = $5, p95_ms = $6, p99_ms = $7
         WHERE id = $1`,
        [
          runId,
          status,
          active?.totalSuccess ?? 0,
          active?.totalErrors ?? 0,
          finalHistogram.p50Ms,
          finalHistogram.p95Ms,
          finalHistogram.p99Ms,
        ]
      );
    } catch (error) {
      await this.control.query(
        `UPDATE lakeload_control.run
         SET status = 'failed', completed_at = NOW(), error_message = $2
         WHERE id = $1`,
        [runId, error instanceof Error ? error.message : 'Unknown load engine error']
      );
      throw error;
    } finally {
      clearInterval(metricTimer);
      this.activeRun = null;
    }
  }

  private async worker(index: number, endAt: number, config: RunConfig) {
    const rampDelay =
      config.rampSeconds <= 0
        ? 0
        : Math.floor((index / Math.max(1, config.concurrency - 1)) * config.rampSeconds * 1000);
    await delay(rampDelay);
    if (!this.activeRun || Date.now() >= endAt) return;
    this.activeRun.activeUsers += 1;

    try {
      while (Date.now() < endAt && this.activeRun && !this.activeRun.cancelled) {
        const started = performance.now();
        try {
          const operation = this.chooseOperation(config.scenario);
          await this.execute(operation);
          const elapsed = performance.now() - started;
          this.histogram.observe(elapsed);
          this.overallHistogram.observe(elapsed);
          this.interval.success += 1;
          this.interval[operation] += 1;
          this.activeRun.totalSuccess += 1;
        } catch {
          const elapsed = performance.now() - started;
          this.histogram.observe(elapsed);
          this.overallHistogram.observe(elapsed);
          this.interval.errors += 1;
          this.activeRun.totalErrors += 1;
          await delay(20);
        }
      }
    } finally {
      if (this.activeRun) this.activeRun.activeUsers -= 1;
    }
  }

  private async openLoop(endAt: number, config: RunConfig) {
    const targetRps = Math.max(1, config.targetRps ?? config.concurrency);
    const intervalMs = 1000 / targetRps;
    const inFlight = new Set<Promise<void>>();
    let nextArrival = performance.now();
    while (Date.now() < endAt && this.activeRun && !this.activeRun.cancelled) {
      const now = performance.now();
      if (now < nextArrival) await delay(Math.min(10, nextArrival - now));
      nextArrival += intervalMs;
      if (inFlight.size >= config.concurrency) {
        this.interval.errors += 1;
        this.activeRun.totalErrors += 1;
        continue;
      }
      const operation = this.chooseOperation(config.scenario);
      const task = this.executeOnce(operation).finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
    await Promise.allSettled(inFlight);
  }

  private async executeOnce(operation: keyof Pick<IntervalCounters, 'reads' | 'writes' | 'complex'>) {
    if (!this.activeRun) return;
    const started = performance.now();
    this.activeRun.activeUsers += 1;
    try {
      await this.execute(operation);
      const elapsed = performance.now() - started;
      this.histogram.observe(elapsed);
      this.overallHistogram.observe(elapsed);
      this.interval.success += 1;
      this.interval[operation] += 1;
      this.activeRun.totalSuccess += 1;
    } catch {
      const elapsed = performance.now() - started;
      this.histogram.observe(elapsed);
      this.overallHistogram.observe(elapsed);
      this.interval.errors += 1;
      this.activeRun.totalErrors += 1;
    } finally {
      if (this.activeRun) this.activeRun.activeUsers -= 1;
    }
  }

  private chooseOperation(scenario: Scenario): keyof Pick<IntervalCounters, 'reads' | 'writes' | 'complex'> {
    const roll = Math.random();
    if (scenario === 'lakebase-point-lookup') return 'reads';
    if (scenario === 'lakebase-transfer') return 'writes';
    if (scenario === 'lakebase-operational-join') return 'complex';
    return roll < 0.55 ? 'reads' : roll < 0.9 ? 'writes' : 'complex';
  }

  private async execute(operation: 'reads' | 'writes' | 'complex') {
    if (operation === 'reads') {
      await this.target.query(
        `SELECT a.balance, a.region, p.price
         FROM lakeload_bench.account a
         CROSS JOIN lakeload_bench.product p
         WHERE a.id = $1 AND p.id = $2`,
        [randomInt(1, 10001), randomInt(1, 1001)]
      );
      return;
    }

    if (operation === 'complex') {
      await this.target.query(
        `SELECT a.region, COUNT(h.id)::int AS events, COALESCE(AVG(ABS(h.amount)), 0)::float AS avg_amount
         FROM lakeload_bench.account a
         LEFT JOIN (
           SELECT id, account_id, amount
           FROM lakeload_bench.history
           ORDER BY created_at DESC
           LIMIT 1000
         ) h ON h.account_id = a.id
         WHERE a.id BETWEEN $1 AND $2
         GROUP BY a.region
         ORDER BY events DESC`,
        [randomInt(1, 9000), randomInt(9001, 10001)]
      );
      return;
    }

    const source = randomInt(1, 10001);
    let target = randomInt(1, 10001);
    if (target === source) target = target === 10000 ? 1 : target + 1;
    const amount = randomInt(1, 1000) / 100;
    const client = await this.target.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE lakeload_bench.account SET balance = balance - $1, updated_at = NOW() WHERE id = $2', [
        amount,
        source,
      ]);
      await client.query('UPDATE lakeload_bench.account SET balance = balance + $1, updated_at = NOW() WHERE id = $2', [
        amount,
        target,
      ]);
      await client.query(
        `INSERT INTO lakeload_bench.history (account_id, counterparty_id, amount)
         VALUES ($1, $2, $3)`,
        [source, target, amount]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async flushMetric(runId: string) {
    if (this.flushing) return;
    const active = this.activeRun;
    if (!active || active.id !== runId) return;
    this.flushing = true;
    try {
      const [histogram, database] = [this.histogram.snapshot(), await this.databaseStats()];
      const counters = this.interval;
      const previous = this.previousDatabaseStats ?? database;
      this.previousDatabaseStats = database;
      this.histogram.reset();
      this.interval = { success: 0, errors: 0, reads: 0, writes: 0, complex: 0 };

      await this.control.query(
        `INSERT INTO lakeload_control.run_metric
         (run_id, elapsed_seconds, active_users, operations, errors, reads, writes, complex_queries,
          p50_ms, p95_ms, p99_ms, histogram, database_tps, commits, rollbacks,
          rows_inserted, rows_updated, rows_deleted, connections_active, connections_idle,
          connections_total, locks_waiting, locks_total, cache_hit_pct, database_bytes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,
                 $19,$20,$21,$22,$23,$24,$25)`,
        [
          runId,
          Math.max(0, Math.round((Date.now() - active.startedAt) / 1000)),
          active.activeUsers,
          counters.success,
          counters.errors,
          counters.reads,
          counters.writes,
          counters.complex,
          histogram.p50Ms,
          histogram.p95Ms,
          histogram.p99Ms,
          JSON.stringify({ boundsMs: histogram.boundsMs, counts: histogram.counts }),
          Math.max(0, database.commits - previous.commits + database.rollbacks - previous.rollbacks),
          Math.max(0, database.commits - previous.commits),
          Math.max(0, database.rollbacks - previous.rollbacks),
          Math.max(0, database.rowsInserted - previous.rowsInserted),
          Math.max(0, database.rowsUpdated - previous.rowsUpdated),
          Math.max(0, database.rowsDeleted - previous.rowsDeleted),
          database.connectionsActive,
          database.connectionsIdle,
          database.connectionsTotal,
          database.locksWaiting,
          database.locksTotal,
          database.cacheHitPct,
          database.databaseBytes,
        ]
      );
    } finally {
      this.flushing = false;
    }
  }

  private async databaseStats(): Promise<DatabaseStats> {
    const result = (await this.target.query(`
      WITH activity AS (
        SELECT COUNT(*) FILTER (WHERE state = 'active' AND pid <> pg_backend_pid())::int AS active,
               COUNT(*) FILTER (WHERE state = 'idle')::int AS idle,
               COUNT(*)::int AS total
        FROM pg_stat_activity WHERE datname = current_database()
      ), lock_state AS (
        SELECT COUNT(*) FILTER (WHERE NOT granted)::int AS waiting,
               COUNT(*)::int AS total
        FROM pg_locks
      )
      SELECT d.xact_commit::bigint AS commits, d.xact_rollback::bigint AS rollbacks,
             d.tup_inserted::bigint AS rows_inserted, d.tup_updated::bigint AS rows_updated,
             d.tup_deleted::bigint AS rows_deleted, activity.active AS connections_active,
             activity.idle AS connections_idle, activity.total AS connections_total,
             lock_state.waiting AS locks_waiting, lock_state.total AS locks_total,
             CASE WHEN d.blks_hit + d.blks_read = 0 THEN 100
                  ELSE ROUND(100.0 * d.blks_hit / (d.blks_hit + d.blks_read), 2) END::float AS cache_hit_pct,
             pg_database_size(current_database())::bigint AS database_bytes
      FROM pg_stat_database d CROSS JOIN activity CROSS JOIN lock_state
      WHERE d.datname = current_database()
    `)) as { rows?: Record<string, unknown>[] };
    const row = result.rows?.[0] ?? {};
    return {
      commits: Number(row.commits ?? 0),
      rollbacks: Number(row.rollbacks ?? 0),
      rowsInserted: Number(row.rows_inserted ?? 0),
      rowsUpdated: Number(row.rows_updated ?? 0),
      rowsDeleted: Number(row.rows_deleted ?? 0),
      connectionsActive: Number(row.connections_active ?? 0),
      connectionsIdle: Number(row.connections_idle ?? 0),
      connectionsTotal: Number(row.connections_total ?? 0),
      locksWaiting: Number(row.locks_waiting ?? 0),
      locksTotal: Number(row.locks_total ?? 0),
      cacheHitPct: Number(row.cache_hit_pct ?? 0),
      databaseBytes: Number(row.database_bytes ?? 0),
    };
  }
}
