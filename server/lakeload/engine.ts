import { LatencyHistogram } from './histogram';

export type Scenario =
  | 'lakebase-point-lookup'
  | 'lakebase-transfer'
  | 'lakebase-mixed'
  | 'lakebase-operational-join'
  | 'lakebase-olap-scan';

export interface RunConfig {
  scenario: Scenario;
  concurrency: number;
  durationSeconds: number;
  rampSeconds: number;
  executionModel: 'closed' | 'open';
  targetRps?: number;
  warmupSeconds: number;
  seed: number;
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
  totalDropped: number;
  totalQueryErrors: number;
  activeUsers: number;
  measureFrom: number;
}

interface IntervalCounters {
  success: number;
  errors: number;
  queryErrors: number;
  offered: number;
  dropped: number;
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
  private interval: IntervalCounters = {
    success: 0,
    errors: 0,
    queryErrors: 0,
    offered: 0,
    dropped: 0,
    reads: 0,
    writes: 0,
    complex: 0,
  };
  private previousDatabaseStats: DatabaseStats | null = null;
  private flushing = false;
  private lastFlushAt = 0;
  private lastDatabaseSampleAt = 0;

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
    const startedAt = Date.now();
    this.activeRun = {
      id: runId,
      cancelled: false,
      startedAt,
      totalSuccess: 0,
      totalErrors: 0,
      totalDropped: 0,
      totalQueryErrors: 0,
      activeUsers: 0,
      measureFrom: startedAt + Math.max(config.warmupSeconds, config.rampSeconds) * 1000,
    };
    this.histogram.reset();
    this.overallHistogram.reset();
    this.interval = emptyCounters();
    this.previousDatabaseStats = await this.databaseStats();
    this.lastFlushAt = Date.now();
    this.lastDatabaseSampleAt = this.lastFlushAt;

    const endAt = this.activeRun.measureFrom + config.durationSeconds * 1000;
    await this.control.query(
      `UPDATE lakeload_control.run SET status = 'running', started_at = NOW(),
       measurement_started_at = NOW() + ($2 * INTERVAL '1 second') WHERE id = $1`,
      [runId, Math.max(config.warmupSeconds, config.rampSeconds)]
    );

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
      await this.flushMetric(runId, true);

      const active = this.activeRun;
      const finalHistogram = this.overallHistogram.snapshot();
      const status = active?.cancelled ? 'cancelled' : 'completed';
      await this.control.query(
        `UPDATE lakeload_control.run
         SET status = $2, completed_at = NOW(), total_operations = $3,
             total_errors = $4, p50_ms = $5, p95_ms = $6, p99_ms = $7,
             dropped_operations = $8, query_errors = $9
         WHERE id = $1`,
        [
          runId,
          status,
          active?.totalSuccess ?? 0,
          active?.totalErrors ?? 0,
          finalHistogram.p50Ms,
          finalHistogram.p95Ms,
          finalHistogram.p99Ms,
          active?.totalDropped ?? 0,
          active?.totalQueryErrors ?? 0,
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
    const random = seededRandom(config.seed + index * 1013);

    try {
      while (Date.now() < endAt && this.activeRun && !this.activeRun.cancelled) {
        this.interval.offered += 1;
        const measured = Date.now() >= this.activeRun.measureFrom;
        const started = performance.now();
        try {
          const operation = this.chooseOperation(config.scenario, random);
          await this.execute(operation, config.scenario, random);
          const elapsed = performance.now() - started;
          this.histogram.observe(elapsed);
          this.interval.success += 1;
          this.interval[operation] += 1;
          if (measured) {
            this.overallHistogram.observe(elapsed);
            this.activeRun.totalSuccess += 1;
          }
        } catch {
          this.interval.errors += 1;
          this.interval.queryErrors += 1;
          if (measured) {
            this.activeRun.totalErrors += 1;
            this.activeRun.totalQueryErrors += 1;
          }
          await delay(20);
        }
      }
    } finally {
      if (this.activeRun) this.activeRun.activeUsers -= 1;
    }
  }

  private async openLoop(endAt: number, config: RunConfig) {
    const targetRps = Math.max(1, config.targetRps ?? config.concurrency);
    const inFlight = new Set<Promise<void>>();
    let nextArrival = performance.now();
    const started = performance.now();
    const random = seededRandom(config.seed);
    while (Date.now() < endAt && this.activeRun && !this.activeRun.cancelled) {
      const now = performance.now();
      if (now < nextArrival) await delay(Math.min(10, nextArrival - now));
      const rampFraction =
        config.rampSeconds <= 0 ? 1 : Math.min(1, Math.max(0.01, (performance.now() - started) / (config.rampSeconds * 1000)));
      nextArrival += 1000 / (targetRps * rampFraction);
      this.interval.offered += 1;
      if (inFlight.size >= config.concurrency) {
        this.interval.errors += 1;
        this.interval.dropped += 1;
        if (Date.now() >= this.activeRun.measureFrom) {
          this.activeRun.totalErrors += 1;
          this.activeRun.totalDropped += 1;
        }
        continue;
      }
      const operation = this.chooseOperation(config.scenario, random);
      const task = this.executeOnce(operation, config.scenario, random).finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
    await Promise.allSettled(inFlight);
  }

  private async executeOnce(
    operation: keyof Pick<IntervalCounters, 'reads' | 'writes' | 'complex'>,
    scenario: Scenario,
    random: () => number
  ) {
    if (!this.activeRun) return;
    const measured = Date.now() >= this.activeRun.measureFrom;
    const started = performance.now();
    this.activeRun.activeUsers += 1;
    try {
      await this.execute(operation, scenario, random);
      const elapsed = performance.now() - started;
      this.histogram.observe(elapsed);
      this.interval.success += 1;
      this.interval[operation] += 1;
      if (measured) {
        this.overallHistogram.observe(elapsed);
        this.activeRun.totalSuccess += 1;
      }
    } catch {
      this.interval.errors += 1;
      this.interval.queryErrors += 1;
      if (measured) {
        this.activeRun.totalErrors += 1;
        this.activeRun.totalQueryErrors += 1;
      }
    } finally {
      if (this.activeRun) this.activeRun.activeUsers -= 1;
    }
  }

  private chooseOperation(
    scenario: Scenario,
    random: () => number
  ): keyof Pick<IntervalCounters, 'reads' | 'writes' | 'complex'> {
    const roll = random();
    if (scenario === 'lakebase-point-lookup') return 'reads';
    if (scenario === 'lakebase-transfer') return 'writes';
    if (scenario === 'lakebase-operational-join' || scenario === 'lakebase-olap-scan') return 'complex';
    return roll < 0.55 ? 'reads' : roll < 0.9 ? 'writes' : 'complex';
  }

  private async execute(operation: 'reads' | 'writes' | 'complex', scenario: Scenario, random: () => number) {
    if (operation === 'reads') {
      await this.target.query(
        `SELECT a.balance, a.region, p.price
         FROM lakeload_bench.account a
         CROSS JOIN lakeload_bench.product p
         WHERE a.id = $1 AND p.id = $2`,
        [randomInteger(random, 1, 1_000_001), randomInteger(random, 1, 10_001)]
      );
      return;
    }

    if (operation === 'complex') {
      if (scenario === 'lakebase-olap-scan') {
        await this.target.query(`
          SELECT a.region, p.category, COUNT(*)::bigint AS events,
                 SUM(ABS(h.amount))::numeric AS gross_amount,
                 COUNT(DISTINCT h.account_id)::bigint AS active_accounts
          FROM lakeload_bench.history h
          JOIN lakeload_bench.account a ON a.id = h.account_id
          JOIN lakeload_bench.product p ON p.id = h.product_id
          WHERE h.id <= 5000000
          GROUP BY a.region, p.category
          ORDER BY gross_amount DESC
        `);
        return;
      }
      await this.target.query(
        `SELECT a.region, COUNT(h.id)::int AS events, COALESCE(AVG(ABS(h.amount)), 0)::float AS avg_amount
         FROM lakeload_bench.account a
         LEFT JOIN LATERAL (
           SELECT id, amount
           FROM lakeload_bench.history
           WHERE account_id = a.id
           ORDER BY created_at DESC
           LIMIT 20
         ) h ON TRUE
         WHERE a.id = $1
         GROUP BY a.region
         ORDER BY events DESC`,
        [randomInteger(random, 1, 1_000_001)]
      );
      return;
    }

    const source = randomInteger(random, 1, 1_000_001);
    let target = randomInteger(random, 1, 1_000_001);
    if (target === source) target = target === 1_000_000 ? 1 : target + 1;
    const amount = randomInteger(random, 1, 1000) / 100;
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
        `INSERT INTO lakeload_bench.history (account_id, counterparty_id, product_id, amount)
         VALUES ($1, $2, 1 + MOD($2 - 1, 10000), $3)`,
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

  private async flushMetric(runId: string, final = false): Promise<void> {
    if (this.flushing) {
      if (!final) return;
      while (this.flushing) await delay(10);
      return this.flushMetric(runId, true);
    }
    const active = this.activeRun;
    if (!active || active.id !== runId) return;
    this.flushing = true;
    try {
      const now = Date.now();
      const intervalMs = Math.max(1, now - this.lastFlushAt);
      this.lastFlushAt = now;
      const histogram = this.histogram.snapshot();
      const counters = this.interval;
      this.histogram.reset();
      this.interval = emptyCounters();
      if (final && counters.offered === 0 && counters.success === 0 && counters.errors === 0) return;
      const database = await this.databaseStats();
      const previous = this.previousDatabaseStats ?? database;
      const databaseIntervalMs = Math.max(1, Date.now() - this.lastDatabaseSampleAt);
      this.lastDatabaseSampleAt = Date.now();
      this.previousDatabaseStats = database;

      await this.control.query(
        `INSERT INTO lakeload_control.run_metric
         (run_id, elapsed_seconds, active_users, operations, errors, reads, writes, complex_queries,
          p50_ms, p95_ms, p99_ms, histogram, database_tps, commits, rollbacks,
          rows_inserted, rows_updated, rows_deleted, connections_active, connections_idle,
          connections_total, locks_waiting, locks_total, cache_hit_pct, database_bytes,
          interval_ms, throughput_rps, offered, dropped, query_errors, mean_ms, max_ms, phase, target_rps)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,
                 $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)`,
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
          Math.max(
            0,
            ((database.commits - previous.commits + database.rollbacks - previous.rollbacks) * 1000) /
              databaseIntervalMs
          ),
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
          intervalMs,
          (counters.success * 1000) / intervalMs,
          counters.offered,
          counters.dropped,
          counters.queryErrors,
          histogram.count === 0 ? 0 : histogram.sumMs / histogram.count,
          histogram.maxMs,
          Date.now() < active.measureFrom ? 'warmup' : 'measure',
          configTargetRate(active, counters, intervalMs),
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

function emptyCounters(): IntervalCounters {
  return { success: 0, errors: 0, queryErrors: 0, offered: 0, dropped: 0, reads: 0, writes: 0, complex: 0 };
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomInteger(random: () => number, minimum: number, maximumExclusive: number) {
  return Math.floor(random() * (maximumExclusive - minimum)) + minimum;
}

function configTargetRate(_active: ActiveRun, counters: IntervalCounters, intervalMs: number) {
  return (counters.offered * 1000) / intervalMs;
}
