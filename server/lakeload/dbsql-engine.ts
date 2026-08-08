import { randomInt } from 'node:crypto';
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
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class DbsqlEngine {
  private active: {
    id: string;
    cancelled: boolean;
    startedAt: number;
    success: number;
    errors: number;
    users: number;
  } | null = null;
  private intervalHistogram = new LatencyHistogram();
  private overallHistogram = new LatencyHistogram();
  private interval = { success: 0, errors: 0 };

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
    this.active = { id: runId, cancelled: false, startedAt: Date.now(), success: 0, errors: 0, users: 0 };
    this.intervalHistogram.reset();
    this.overallHistogram.reset();
    this.interval = { success: 0, errors: 0 };
    const endAt = Date.now() + config.durationSeconds * 1000;
    await this.control.query(`UPDATE lakeload_control.run SET status = 'running', started_at = NOW() WHERE id = $1`, [
      runId,
    ]);
    const timer = setInterval(() => void this.flush(runId), 1000);
    try {
      const workers = Array.from({ length: config.concurrency }, (_, index) => this.worker(index, endAt, config));
      await Promise.all(workers);
      await this.flush(runId);
      const snapshot = this.overallHistogram.snapshot();
      const status = this.active.cancelled ? 'cancelled' : 'completed';
      await this.control.query(
        `UPDATE lakeload_control.run SET status=$2, completed_at=NOW(), total_operations=$3,
         total_errors=$4, p50_ms=$5, p95_ms=$6, p99_ms=$7 WHERE id=$1`,
        [runId, status, this.active.success, this.active.errors, snapshot.p50Ms, snapshot.p95Ms, snapshot.p99Ms]
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
    this.active.users += 1;
    const openLoopDelay =
      config.executionModel === 'open' ? 1000 / Math.max(1, config.targetRps ?? config.concurrency) : 0;
    try {
      while (Date.now() < endAt && this.active && !this.active.cancelled) {
        const started = performance.now();
        try {
          await this.analytics.query(this.statement(config.scenario));
          const elapsed = performance.now() - started;
          this.intervalHistogram.observe(elapsed);
          this.overallHistogram.observe(elapsed);
          this.interval.success += 1;
          this.active.success += 1;
        } catch {
          const elapsed = performance.now() - started;
          this.intervalHistogram.observe(elapsed);
          this.overallHistogram.observe(elapsed);
          this.interval.errors += 1;
          this.active.errors += 1;
          await delay(100);
        }
        if (openLoopDelay > 0) await delay(openLoopDelay * config.concurrency);
      }
    } finally {
      if (this.active) this.active.users -= 1;
    }
  }

  private statement(scenario: DbsqlRunConfig['scenario']) {
    const namespace = this.namespace();
    if (scenario === 'dbsql-point-lookup') {
      return `SELECT id, region, balance FROM ${namespace}.lakeload_account WHERE id = ${randomInt(1, 10_001)}`;
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

  private async flush(runId: string) {
    if (!this.active || this.active.id !== runId) return;
    const histogram = this.intervalHistogram.snapshot();
    const counters = this.interval;
    this.intervalHistogram.reset();
    this.interval = { success: 0, errors: 0 };
    await this.control.query(
      `INSERT INTO lakeload_control.run_metric
       (run_id, elapsed_seconds, active_users, operations, errors, reads, writes, complex_queries,
        p50_ms, p95_ms, p99_ms, histogram)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,$11::jsonb)`,
      [
        runId,
        Math.max(0, Math.round((Date.now() - this.active.startedAt) / 1000)),
        this.active.users,
        counters.success,
        counters.errors,
        counters.success,
        counters.success,
        histogram.p50Ms,
        histogram.p95Ms,
        histogram.p99Ms,
        JSON.stringify({ boundsMs: histogram.boundsMs, counts: histogram.counts }),
      ]
    );
  }
}
