import type { Application, Request } from 'express';
import { createLakebasePool } from '@databricks/appkit';
import { z } from 'zod';
import { LoadEngine, type RunConfig } from '../../lakeload/engine';

interface AppKitWithLakebase {
  lakebase: {
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  };
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

const RunRequest = z.object({
  scenario: z.enum(['mixed-oltp', 'read-heavy', 'write-heavy', 'complex-queries']),
  concurrency: z.number().int().min(1).max(150),
  durationSeconds: z.number().int().min(10).max(600),
  rampSeconds: z.number().int().min(0).max(120),
});

const CONTROL_SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS lakeload_control;

  CREATE TABLE IF NOT EXISTS lakeload_control.run (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    concurrency INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL,
    ramp_seconds INTEGER NOT NULL,
    requested_by TEXT NOT NULL,
    config JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    total_operations BIGINT NOT NULL DEFAULT 0,
    total_errors BIGINT NOT NULL DEFAULT 0,
    p50_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    p95_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    p99_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    error_message TEXT
  );

  CREATE TABLE IF NOT EXISTS lakeload_control.run_metric (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES lakeload_control.run(id) ON DELETE CASCADE,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    elapsed_seconds INTEGER NOT NULL,
    active_users INTEGER NOT NULL,
    operations INTEGER NOT NULL,
    errors INTEGER NOT NULL,
    reads INTEGER NOT NULL,
    writes INTEGER NOT NULL,
    complex_queries INTEGER NOT NULL,
    p50_ms DOUBLE PRECISION NOT NULL,
    p95_ms DOUBLE PRECISION NOT NULL,
    p99_ms DOUBLE PRECISION NOT NULL,
    histogram JSONB NOT NULL
  );

  DO $$
  BEGIN
    IF to_regclass('lakeload_control.run_metric_run_time_idx') IS NULL THEN
      CREATE INDEX run_metric_run_time_idx
        ON lakeload_control.run_metric(run_id, recorded_at);
    END IF;
  END
  $$;
`;

const BENCHMARK_SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS lakeload_bench;

  CREATE TABLE IF NOT EXISTS lakeload_bench.account (
    id INTEGER PRIMARY KEY,
    region TEXT NOT NULL,
    balance NUMERIC(14, 2) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS lakeload_bench.product (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL,
    price NUMERIC(10, 2) NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lakeload_bench.history (
    id BIGSERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL,
    counterparty_id INTEGER NOT NULL,
    amount NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  DO $$
  BEGIN
    IF to_regclass('lakeload_bench.history_account_time_idx') IS NULL THEN
      CREATE INDEX history_account_time_idx
        ON lakeload_bench.history(account_id, created_at DESC);
    END IF;
  END
  $$;
`;

const RUN_SELECT = `
  SELECT id, scenario, status, concurrency, duration_seconds, ramp_seconds,
         requested_by, created_at, started_at, completed_at,
         total_operations, total_errors, p50_ms, p95_ms, p99_ms, error_message
  FROM lakeload_control.run
`;

function actor(req: Request) {
  return req.header('x-forwarded-email') ?? 'local-operator';
}

export async function setupLakeLoadRoutes(appkit: AppKitWithLakebase) {
  await appkit.lakebase.query(CONTROL_SCHEMA_SQL);
  await appkit.lakebase.query(
    `UPDATE lakeload_control.run
     SET status = 'failed', completed_at = NOW(), error_message = 'App restarted during run'
     WHERE status IN ('queued', 'running')`
  );

  const endpoint = process.env.TARGET_LAKEBASE_ENDPOINT;
  const host = process.env.TARGET_PGHOST;
  const database = process.env.TARGET_PGDATABASE ?? 'databricks_postgres';
  if (!endpoint || !host) {
    throw new Error('TARGET_LAKEBASE_ENDPOINT and TARGET_PGHOST are required');
  }

  const targetPool = createLakebasePool({
    endpoint,
    host,
    database,
    sslMode: 'require',
    max: Number(process.env.TARGET_POOL_SIZE ?? '80'),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    telemetry: true,
    logger: { error: true, warn: true },
  });

  await targetPool.query(BENCHMARK_SCHEMA_SQL);
  await targetPool.query(
    `INSERT INTO lakeload_bench.account (id, region, balance)
     SELECT id, (ARRAY['APAC', 'AMER', 'EMEA'])[1 + (id % 3)], 10000 + (id % 5000)
     FROM generate_series(1, 10000) AS id
     ON CONFLICT (id) DO NOTHING`
  );
  await targetPool.query(
    `INSERT INTO lakeload_bench.product (id, category, price)
     SELECT id, (ARRAY['Compute', 'Storage', 'AI', 'Platform'])[1 + (id % 4)], 5 + (id % 995)
     FROM generate_series(1, 1000) AS id
     ON CONFLICT (id) DO NOTHING`
  );

  const engine = new LoadEngine(targetPool, appkit.lakebase);

  appkit.server.extend((app) => {
    app.get('/api/lakeload/overview', async (_req, res) => {
      try {
        const [runs, target] = await Promise.all([
          appkit.lakebase.query(`${RUN_SELECT} ORDER BY created_at DESC LIMIT 20`),
          targetPool.query<{
            database: string;
            postgres_version: string;
            accounts: number;
            products: number;
            history_rows: number;
          }>(
            `SELECT current_database() AS database,
                    current_setting('server_version') AS postgres_version,
                    (SELECT COUNT(*)::int FROM lakeload_bench.account) AS accounts,
                    (SELECT COUNT(*)::int FROM lakeload_bench.product) AS products,
                    (SELECT COUNT(*)::int FROM lakeload_bench.history) AS history_rows`
          ),
        ]);
        const activeId = engine.activeRunId;
        const metrics = activeId
          ? await appkit.lakebase.query(
              `SELECT recorded_at, elapsed_seconds, active_users, operations, errors,
                      reads, writes, complex_queries, p50_ms, p95_ms, p99_ms
               FROM lakeload_control.run_metric
               WHERE run_id = $1 ORDER BY recorded_at ASC`,
              [activeId]
            )
          : { rows: [] };
        res.json({
          runs: runs.rows,
          activeRunId: activeId,
          activeMetrics: metrics.rows,
          target: target.rows[0],
          endpoint: {
            branch: 'benchmark',
            endpoint: endpoint.split('/').slice(-1)[0] ?? 'primary',
            poolSize: Number(process.env.TARGET_POOL_SIZE ?? '80'),
          },
        });
      } catch (error) {
        console.error('[lakeload] Failed to load overview', error);
        res.status(500).json({ error: 'Failed to load LakeLoad overview' });
      }
    });

    app.get('/api/lakeload/runs/:id', async (req, res) => {
      try {
        const [run, metrics] = await Promise.all([
          appkit.lakebase.query(`${RUN_SELECT} WHERE id = $1`, [req.params.id]),
          appkit.lakebase.query(
            `SELECT recorded_at, elapsed_seconds, active_users, operations, errors,
                    reads, writes, complex_queries, p50_ms, p95_ms, p99_ms
             FROM lakeload_control.run_metric
             WHERE run_id = $1 ORDER BY recorded_at ASC`,
            [req.params.id]
          ),
        ]);
        if (run.rows.length === 0) {
          res.status(404).json({ error: 'Run not found' });
          return;
        }
        res.json({ run: run.rows[0], metrics: metrics.rows });
      } catch (error) {
        console.error('[lakeload] Failed to load run', error);
        res.status(500).json({ error: 'Failed to load run' });
      }
    });

    app.post('/api/lakeload/runs', async (req, res) => {
      const parsed = RunRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid workload configuration', issues: parsed.error.issues });
        return;
      }
      if (engine.activeRunId) {
        res.status(409).json({ error: 'Another run is already active' });
        return;
      }

      try {
        const config: RunConfig = parsed.data;
        const created = await appkit.lakebase.query(
          `INSERT INTO lakeload_control.run
           (scenario, concurrency, duration_seconds, ramp_seconds, requested_by, config)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           RETURNING id`,
          [
            config.scenario,
            config.concurrency,
            config.durationSeconds,
            config.rampSeconds,
            actor(req),
            JSON.stringify(config),
          ]
        );
        const runId = String(created.rows[0].id);
        void engine.start(runId, config).catch((error) => {
          console.error(`[lakeload] Run ${runId} failed`, error);
        });
        res.status(202).json({ runId });
      } catch (error) {
        console.error('[lakeload] Failed to start run', error);
        res.status(500).json({ error: 'Failed to start load test' });
      }
    });

    app.delete('/api/lakeload/runs/:id', (req, res) => {
      if (!engine.cancel(req.params.id)) {
        res.status(404).json({ error: 'Active run not found' });
        return;
      }
      res.status(202).json({ status: 'cancelling' });
    });
  });
}
