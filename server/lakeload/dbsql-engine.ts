import { LatencyHistogram } from './histogram';

interface ControlDatabase {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface AnalyticsClient {
  query(text: string, parameters?: Record<string, unknown>): Promise<unknown>;
}

export interface DbsqlRunConfig {
  scenario: 'dbsql-point-lookup' | 'dbsql-olap-scan' | 'dbsql-window-analysis';
  concurrency: number;
  durationSeconds: number;
  rampSeconds: number;
  executionModel: 'closed' | 'open';
  targetRps?: number;
  warmupSeconds: number;
  seed: number;
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class DbsqlEngine {
  private active: {
    id: string;
    cancelled: boolean;
    startedAt: number;
    success: number;
    errors: number;
    dropped: number;
    queryErrors: number;
    users: number;
    measureFrom: number;
    scenario: DbsqlRunConfig['scenario'];
  } | null = null;
  private intervalHistogram = new LatencyHistogram();
  private overallHistogram = new LatencyHistogram();
  private interval = { success: 0, errors: 0, offered: 0, dropped: 0, queryErrors: 0 };
  private lastFlushAt = 0;
  private flushing = false;

  constructor(
    private readonly analytics: AnalyticsClient,
    private readonly control: ControlDatabase,
    private readonly namespace: () => string = () => '`main`.`lakeload`'
  ) {}

  get activeRunId() {
    return this.active?.id ?? null;
  }

  cancel(runId: string) {
    if (this.active?.id !== runId) return false;
    this.active.cancelled = true;
    return true;
  }

  async start(runId: string, config: DbsqlRunConfig) {
    if (this.active) throw new Error('A DBSQL test is already running');
    const startedAt = Date.now();
    this.active = {
      id: runId,
      cancelled: false,
      startedAt,
      success: 0,
      errors: 0,
      dropped: 0,
      queryErrors: 0,
      users: 0,
      measureFrom: startedAt + Math.max(config.warmupSeconds, config.rampSeconds) * 1000,
      scenario: config.scenario,
    };
    this.intervalHistogram.reset();
    this.overallHistogram.reset();
    this.interval = emptyInterval();
    this.lastFlushAt = Date.now();
    const endAt = this.active.measureFrom + config.durationSeconds * 1000;
    await this.control.query(
      `UPDATE lakeload_control.run SET status = 'running', started_at = NOW(),
       measurement_started_at = NOW() + ($2 * INTERVAL '1 second') WHERE id = $1`,
      [runId, Math.max(config.warmupSeconds, config.rampSeconds)]
    );
    const timer = setInterval(() => void this.flush(runId), 1000);
    try {
      if (config.executionModel === 'open') await this.openLoop(endAt, config);
      else {
        const workers = Array.from({ length: config.concurrency }, (_, index) => this.worker(index, endAt, config));
        await Promise.all(workers);
      }
      await this.flush(runId, true);
      const snapshot = this.overallHistogram.snapshot();
      const status = this.active.cancelled ? 'cancelled' : 'completed';
      await this.control.query(
        `UPDATE lakeload_control.run SET status=$2, completed_at=NOW(), total_operations=$3,
         total_errors=$4, p50_ms=$5, p95_ms=$6, p99_ms=$7,
         dropped_operations=$8,query_errors=$9 WHERE id=$1`,
        [
          runId,
          status,
          this.active.success,
          this.active.errors,
          snapshot.p50Ms,
          snapshot.p95Ms,
          snapshot.p99Ms,
          this.active.dropped,
          this.active.queryErrors,
        ]
      );
    } catch (error) {
      await this.control.query(
        `UPDATE lakeload_control.run SET status='failed', completed_at=NOW(), error_message=$2 WHERE id=$1`,
        [runId, error instanceof Error ? error.message : 'Unknown DBSQL error']
      );
      throw error;
    } finally {
      clearInterval(timer);
      this.active = null;
    }
  }

  private async worker(index: number, endAt: number, config: DbsqlRunConfig) {
    await delay(
      config.rampSeconds <= 0 ? 0 : (index / Math.max(1, config.concurrency - 1)) * config.rampSeconds * 1000
    );
    if (!this.active) return;
    const random = seededRandom(config.seed + index * 1013);
    while (Date.now() < endAt && this.active && !this.active.cancelled) {
      this.interval.offered += 1;
      await this.executeOnce(config.scenario, random);
    }
  }

  private async openLoop(endAt: number, config: DbsqlRunConfig) {
    const targetRps = Math.max(1, config.targetRps ?? config.concurrency);
    const inFlight = new Set<Promise<void>>();
    const random = seededRandom(config.seed);
    const started = performance.now();
    let nextArrival = performance.now();
    while (Date.now() < endAt && this.active && !this.active.cancelled) {
      const now = performance.now();
      if (now < nextArrival) await delay(Math.min(10, nextArrival - now));
      const rampFraction =
        config.rampSeconds <= 0 ? 1 : Math.min(1, Math.max(0.01, (performance.now() - started) / (config.rampSeconds * 1000)));
      nextArrival += 1000 / (targetRps * rampFraction);
      this.interval.offered += 1;
      if (inFlight.size >= config.concurrency) {
        this.interval.errors += 1;
        this.interval.dropped += 1;
        if (Date.now() >= this.active.measureFrom) {
          this.active.errors += 1;
          this.active.dropped += 1;
        }
        continue;
      }
      const task = this.executeOnce(config.scenario, random).finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
    await Promise.allSettled(inFlight);
  }

  private async executeOnce(scenario: DbsqlRunConfig['scenario'], random: () => number) {
    if (!this.active) return;
    const measured = Date.now() >= this.active.measureFrom;
    const started = performance.now();
    this.active.users += 1;
    try {
      await this.analytics.query(this.statement(scenario, random));
      const elapsed = performance.now() - started;
      this.intervalHistogram.observe(elapsed);
      this.interval.success += 1;
      if (measured) {
        this.overallHistogram.observe(elapsed);
        this.active.success += 1;
      }
    } catch {
      this.interval.errors += 1;
      this.interval.queryErrors += 1;
      if (measured) {
        this.active.errors += 1;
        this.active.queryErrors += 1;
      }
      await delay(100);
    } finally {
      if (this.active) this.active.users -= 1;
    }
  }

  private statement(scenario: DbsqlRunConfig['scenario'], random: () => number) {
    const namespace = this.namespace();
    if (scenario === 'dbsql-point-lookup') {
      const accountId = randomInteger(random, 1, 1_000_001);
      const productId = randomInteger(random, 1, 10_001);
      return `SELECT a.balance, a.region, p.price
        FROM ${namespace}.lakeload_account a CROSS JOIN ${namespace}.lakeload_product p
        WHERE a.id = ${accountId} AND p.id = ${productId}`;
    }
    if (scenario === 'dbsql-window-analysis') {
      return `WITH customer_totals AS (
        SELECT account_id, region, SUM(ABS(amount)) AS total_amount, COUNT(*) AS events
        FROM ${namespace}.lakeload_history GROUP BY account_id, region
      ) SELECT account_id, region, total_amount, events,
        DENSE_RANK() OVER (PARTITION BY region ORDER BY total_amount DESC) AS regional_rank
        FROM customer_totals QUALIFY regional_rank <= 100`;
    }
    return `SELECT a.region, p.category, COUNT(*) AS events, SUM(ABS(h.amount)) AS gross_amount,
      APPROX_COUNT_DISTINCT(h.account_id) AS active_accounts
      FROM ${namespace}.lakeload_history h
      JOIN ${namespace}.lakeload_account a ON a.id = h.account_id
      JOIN ${namespace}.lakeload_product p ON p.id = h.product_id
      WHERE h.id <= 5000000
      GROUP BY a.region, p.category ORDER BY gross_amount DESC`;
  }

  private async flush(runId: string, final = false): Promise<void> {
    if (this.flushing) {
      if (!final) return;
      while (this.flushing) await delay(10);
      return this.flush(runId, true);
    }
    if (!this.active || this.active.id !== runId) return;
    this.flushing = true;
    try {
    const now = Date.now();
    const intervalMs = Math.max(1, now - this.lastFlushAt);
    this.lastFlushAt = now;
    const histogram = this.intervalHistogram.snapshot();
    const counters = this.interval;
    this.intervalHistogram.reset();
    this.interval = emptyInterval();
    if (final && counters.offered === 0 && counters.success === 0 && counters.errors === 0) return;
    const isPointLookup = this.active.scenario === 'dbsql-point-lookup';
    await this.control.query(
      `INSERT INTO lakeload_control.run_metric
       (run_id, elapsed_seconds, active_users, operations, errors, reads, writes, complex_queries,
        p50_ms, p95_ms, p99_ms, histogram,interval_ms,throughput_rps,offered,dropped,
        query_errors,mean_ms,max_ms,phase,target_rps)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        runId,
        Math.max(0, Math.round((Date.now() - this.active.startedAt) / 1000)),
        this.active.users,
        counters.success,
        counters.errors,
        isPointLookup ? counters.success : 0,
        isPointLookup ? 0 : counters.success,
        histogram.p50Ms,
        histogram.p95Ms,
        histogram.p99Ms,
        JSON.stringify({ boundsMs: histogram.boundsMs, counts: histogram.counts }),
        intervalMs,
        (counters.success * 1000) / intervalMs,
        counters.offered,
        counters.dropped,
        counters.queryErrors,
        histogram.count === 0 ? 0 : histogram.sumMs / histogram.count,
        histogram.maxMs,
        Date.now() < this.active.measureFrom ? 'warmup' : 'measure',
        (counters.offered * 1000) / intervalMs,
      ]
    );
    } finally {
      this.flushing = false;
    }
  }
}

function emptyInterval() {
  return { success: 0, errors: 0, offered: 0, dropped: 0, queryErrors: 0 };
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
