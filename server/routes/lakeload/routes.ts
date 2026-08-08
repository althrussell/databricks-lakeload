import type { Application, Request } from 'express';
import { createLakebasePool, getWorkspaceClient } from '@databricks/appkit';
import { z } from 'zod';
import { DbsqlEngine, type DbsqlRunConfig } from '../../lakeload/dbsql-engine';
import { LoadEngine, type RunConfig } from '../../lakeload/engine';
import { SCENARIOS, scenarioById, type ScenarioId } from '../../lakeload/scenarios';

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface AppKitServices {
  lakebase: Queryable;
  analytics: { query(text: string, parameters?: Record<string, unknown>): Promise<unknown> };
  server: { extend(fn: (app: Application) => void): void };
}

const RunRequest = z.object({
  scenario: z.string().refine((value): value is ScenarioId => scenarioById.has(value as ScenarioId)),
  concurrency: z.number().int().min(1).max(150),
  durationSeconds: z.number().int().min(10).max(600),
  rampSeconds: z.number().int().min(0).max(120),
  executionModel: z.enum(['closed', 'open']).default('closed'),
  targetRps: z.number().int().min(1).max(5_000).optional(),
});

const CONTROL_SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS lakeload_control;
  CREATE TABLE IF NOT EXISTS lakeload_control.run (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), scenario TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    concurrency INTEGER NOT NULL, duration_seconds INTEGER NOT NULL, ramp_seconds INTEGER NOT NULL,
    requested_by TEXT NOT NULL, config JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, total_operations BIGINT NOT NULL DEFAULT 0,
    total_errors BIGINT NOT NULL DEFAULT 0, p50_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    p95_ms DOUBLE PRECISION NOT NULL DEFAULT 0, p99_ms DOUBLE PRECISION NOT NULL DEFAULT 0, error_message TEXT
  );
  ALTER TABLE lakeload_control.run ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'lakebase';
  ALTER TABLE lakeload_control.run ADD COLUMN IF NOT EXISTS execution_model TEXT NOT NULL DEFAULT 'closed';
  ALTER TABLE lakeload_control.run ADD COLUMN IF NOT EXISTS target_rps INTEGER;
  ALTER TABLE lakeload_control.run ADD COLUMN IF NOT EXISTS environment JSONB NOT NULL DEFAULT '{}'::jsonb;
  CREATE TABLE IF NOT EXISTS lakeload_control.run_metric (
    id BIGSERIAL PRIMARY KEY, run_id UUID NOT NULL REFERENCES lakeload_control.run(id) ON DELETE CASCADE,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), elapsed_seconds INTEGER NOT NULL, active_users INTEGER NOT NULL,
    operations INTEGER NOT NULL, errors INTEGER NOT NULL, reads INTEGER NOT NULL, writes INTEGER NOT NULL,
    complex_queries INTEGER NOT NULL, p50_ms DOUBLE PRECISION NOT NULL, p95_ms DOUBLE PRECISION NOT NULL,
    p99_ms DOUBLE PRECISION NOT NULL, histogram JSONB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS run_metric_run_time_idx ON lakeload_control.run_metric(run_id, recorded_at);
`;

const BENCHMARK_SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS lakeload_bench;
  CREATE TABLE IF NOT EXISTS lakeload_bench.dataset_marker (
    id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, seed BIGINT NOT NULL,
    prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), prepared_by TEXT NOT NULL DEFAULT current_user
  );
  CREATE TABLE IF NOT EXISTS lakeload_bench.account (
    id INTEGER PRIMARY KEY, region TEXT NOT NULL, balance NUMERIC(14,2) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS lakeload_bench.product (
    id INTEGER PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '', price NUMERIC(10,2) NOT NULL
  );
  ALTER TABLE lakeload_bench.product ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
  ALTER TABLE lakeload_bench.product ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
  CREATE TABLE IF NOT EXISTS lakeload_bench.history (
    id BIGSERIAL PRIMARY KEY, account_id INTEGER NOT NULL, counterparty_id INTEGER NOT NULL,
    amount NUMERIC(10,2) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS history_account_time_idx ON lakeload_bench.history(account_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS lakeload_bench.orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'created',
    total NUMERIC(12,2) NOT NULL, run_tag TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

const DBSQL_SETUP = [
  'CREATE SCHEMA IF NOT EXISTS main.lakeload',
  `CREATE TABLE IF NOT EXISTS main.lakeload.account USING DELTA AS
   SELECT id, element_at(array('APAC','AMER','EMEA'), CAST(1 + pmod(id,3) AS INT)) AS region,
   CAST(10000 + pmod(id,5000) AS DECIMAL(14,2)) AS balance FROM range(1,1000001)`,
  `CREATE TABLE IF NOT EXISTS main.lakeload.product USING DELTA AS
   SELECT id, element_at(array('Compute','Storage','AI','Platform'),CAST(1+pmod(id,4) AS INT)) AS category,
   concat('Product ',id) AS title, concat('Deterministic benchmark product ',id) AS description,
   CAST(5+pmod(id,995) AS DECIMAL(10,2)) AS price FROM range(1,10001)`,
  `CREATE TABLE IF NOT EXISTS main.lakeload.history USING DELTA AS
   SELECT id, 1+pmod(id*7919,1000000) AS account_id,
   element_at(array('APAC','AMER','EMEA'),CAST(1+pmod(id,3) AS INT)) AS region,
   1+pmod(id*104729,1000000) AS counterparty_id, 1+pmod(id,10000) AS product_id,
   CAST((pmod(id,20001)-10000)/100.0 AS DECIMAL(10,2)) AS amount,
   timestampadd(SECOND,-pmod(id,2592000),current_timestamp()) AS created_at FROM range(1,5000001)`,
];

const RUN_SELECT = `SELECT id, scenario, engine, status, concurrency, duration_seconds, ramp_seconds,
  execution_model, target_rps, requested_by, created_at, started_at, completed_at, total_operations,
  total_errors, p50_ms, p95_ms, p99_ms, error_message, environment FROM lakeload_control.run`;

function actor(req: Request) {
  return req.header('x-forwarded-email') ?? 'local-operator';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function setupLakeLoadRoutes(appkit: AppKitServices) {
  await appkit.lakebase.query(CONTROL_SCHEMA_SQL);
  await appkit.lakebase.query(
    `UPDATE lakeload_control.run SET status='failed', completed_at=NOW(), error_message='App restarted during run'
     WHERE status IN ('queued','running')`
  );
  const endpoint = process.env.TARGET_LAKEBASE_ENDPOINT;
  let host = process.env.TARGET_PGHOST;
  const database = process.env.TARGET_PGDATABASE ?? 'databricks_postgres';
  if (!endpoint) throw new Error('TARGET_LAKEBASE_ENDPOINT is required');
  if (!host) {
    const endpointResource = (await getWorkspaceClient({}).apiClient.request({
      path: `/api/2.0/postgres/${endpoint}`,
      method: 'GET',
      headers: new Headers(),
      raw: false,
    })) as { status?: { hosts?: { host?: string } } };
    host = endpointResource.status?.hosts?.host;
  }
  if (!host) throw new Error(`Lakebase host could not be resolved for ${endpoint}`);
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
  await prepareLakebase(targetPool);
  const lakebaseEngine = new LoadEngine(targetPool, appkit.lakebase);
  const dbsqlEngine = new DbsqlEngine(appkit.analytics, appkit.lakebase);

  appkit.server.extend((app) => {
    app.get('/api/lakeload/overview', async (_req, res) => {
      try {
        const [runs, target, readiness] = await Promise.all([
          appkit.lakebase.query(`${RUN_SELECT} ORDER BY created_at DESC LIMIT 50`),
          targetPool.query(`SELECT current_database() AS database, current_setting('server_version') AS postgres_version,
            (SELECT COUNT(*)::int FROM lakeload_bench.account) AS accounts,
            (SELECT COUNT(*)::int FROM lakeload_bench.product) AS products,
            (SELECT COUNT(*)::int FROM lakeload_bench.history) AS history_rows`),
          getReadiness(targetPool, appkit.analytics),
        ]);
        const activeId = lakebaseEngine.activeRunId ?? dbsqlEngine.activeRunId;
        const metrics = activeId ? await metricsFor(appkit.lakebase, activeId) : { rows: [] };
        res.json({
          scenarios: SCENARIOS,
          runs: runs.rows,
          activeRunId: activeId,
          activeMetrics: metrics.rows,
          target: (target.rows[0] ?? {}) as Record<string, unknown>,
          readiness,
          endpoint: {
            branch: endpoint.split('/')[3] ?? 'benchmark',
            endpoint: endpoint.split('/').slice(-1)[0] ?? 'primary',
            poolSize: Number(process.env.TARGET_POOL_SIZE ?? '80'),
            autoscaling: '1–4 CU',
          },
        });
      } catch (error) {
        console.error('[lakeload] overview failed', error);
        res.status(500).json({ error: `Overview failed: ${errorMessage(error)}` });
      }
    });

    app.post('/api/lakeload/setup', async (req, res) => {
      try {
        await prepareLakebase(targetPool);
        for (const statement of DBSQL_SETUP) await appkit.analytics.query(statement);
        const notebookPrincipal = actor(req);
        if (notebookPrincipal !== 'local-operator') {
          const quotedPrincipal = notebookPrincipal.replace(/`/g, '``');
          await appkit.analytics.query(`GRANT USE SCHEMA ON SCHEMA main.lakeload TO \`${quotedPrincipal}\``);
          await appkit.analytics.query(`GRANT SELECT ON SCHEMA main.lakeload TO \`${quotedPrincipal}\``);
        }
        res.json({ status: 'ready', message: 'Lakebase and Delta benchmark datasets are ready.' });
      } catch (error) {
        res.status(500).json({ error: `Setup stopped: ${errorMessage(error)}` });
      }
    });

    app.get('/api/lakeload/runs/:id', async (req, res) => {
      try {
        const [run, metrics] = await Promise.all([
          appkit.lakebase.query(`${RUN_SELECT} WHERE id=$1`, [req.params.id]),
          metricsFor(appkit.lakebase, req.params.id),
        ]);
        if (!run.rows[0]) return void res.status(404).json({ error: 'Run not found' });
        res.json({ run: run.rows[0], metrics: metrics.rows });
      } catch (error) {
        res.status(500).json({ error: `Run lookup failed: ${errorMessage(error)}` });
      }
    });

    app.post('/api/lakeload/runs', async (req, res) => {
      const parsed = RunRequest.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: 'Invalid run configuration', issues: parsed.error.issues });
      if (lakebaseEngine.activeRunId || dbsqlEngine.activeRunId)
        return void res.status(409).json({ error: 'Another run is active' });
      const definition = scenarioById.get(parsed.data.scenario as ScenarioId)!;
      if (!definition.runnable)
        return void res.status(409).json({ error: `${definition.name} requires ${definition.prerequisite} setup. Use the readiness instructions first.` });
      try {
        const config = parsed.data;
        const created = await appkit.lakebase.query(
          `INSERT INTO lakeload_control.run
           (scenario,engine,concurrency,duration_seconds,ramp_seconds,execution_model,target_rps,requested_by,config,environment)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb) RETURNING id`,
          [
            definition.id,
            definition.engine,
            config.concurrency,
            config.durationSeconds,
            config.rampSeconds,
            config.executionModel,
            config.targetRps ?? null,
            actor(req),
            JSON.stringify(config),
            JSON.stringify({ seed: 424242, catalog: 'main', schema: 'lakeload', endpoint: endpoint.split('/').slice(-1)[0] }),
          ]
        );
        const runId = String(created.rows[0].id);
        const task = definition.engine === 'dbsql'
          ? dbsqlEngine.start(runId, config as DbsqlRunConfig)
          : lakebaseEngine.start(runId, config as RunConfig);
        void task.catch((error) => console.error(`[lakeload] run ${runId} failed`, error));
        res.status(202).json({ runId });
      } catch (error) {
        res.status(500).json({ error: `Run could not start: ${errorMessage(error)}` });
      }
    });

    app.delete('/api/lakeload/runs/:id', (req, res) => {
      if (!lakebaseEngine.cancel(req.params.id) && !dbsqlEngine.cancel(req.params.id))
        return void res.status(404).json({ error: 'Active run not found' });
      res.status(202).json({ status: 'cancelling' });
    });

    app.post('/api/lakeload/verify-invariant', async (_req, res) => {
      const result = await targetPool.query(`SELECT SUM(balance)::text AS total_balance,
        COUNT(*) FILTER (WHERE balance < 0)::int AS negative_accounts FROM lakeload_bench.account`);
      res.json({ ...result.rows[0], expectedTotal: '124995000.00' });
    });
  });
}

async function metricsFor(control: Queryable, runId: string) {
  return control.query(`SELECT recorded_at,elapsed_seconds,active_users,operations,errors,reads,writes,
    complex_queries,p50_ms,p95_ms,p99_ms FROM lakeload_control.run_metric WHERE run_id=$1 ORDER BY recorded_at`, [runId]);
}

async function prepareLakebase(target: Queryable) {
  await target.query(BENCHMARK_SCHEMA_SQL);
  await target.query(`INSERT INTO lakeload_bench.dataset_marker(id,schema_version,seed) VALUES(1,2,424242)
    ON CONFLICT(id) DO UPDATE SET schema_version=EXCLUDED.schema_version, seed=EXCLUDED.seed, prepared_at=NOW()`);
  await target.query(`INSERT INTO lakeload_bench.account(id,region,balance)
    SELECT id,(ARRAY['APAC','AMER','EMEA'])[1+(id%3)],10000+(id%5000) FROM generate_series(1,10000) id
    ON CONFLICT(id) DO NOTHING`);
  await target.query(`INSERT INTO lakeload_bench.product(id,category,title,description,price)
    SELECT id,(ARRAY['Compute','Storage','AI','Platform'])[1+(id%4)],'Product '||id,
    'Deterministic benchmark product '||id,5+(id%995) FROM generate_series(1,1000) id
    ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description`);
}

async function getReadiness(target: Queryable, analytics: AppKitServices['analytics']) {
  const checks = await target.query(`SELECT
    current_user AS pg_user,
    EXISTS(SELECT 1 FROM pg_extension WHERE extname='wal2delta') AS cdf_installed,
    EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='wal2delta') AS cdf_available,
    EXISTS(SELECT 1 FROM pg_extension WHERE extname IN ('lakebase_text','lakebase_vector')) AS search_installed,
    EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='lakebase_text') AS search_available,
    COALESCE(bool_and(c.relreplident='f'),false) AS replica_identity_full
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='lakeload_bench' AND c.relkind='r'`);
  let dbsqlReady = true;
  let dbsqlDetail = 'Warehouse connected';
  try {
    await analytics.query('SELECT 1 AS ready');
  } catch (error) {
    dbsqlReady = false;
    dbsqlDetail = errorMessage(error);
  }
  const pg = checks.rows[0] ?? {};
  const cdfReady = Boolean(pg.cdf_installed && pg.replica_identity_full && process.env.CDF_DELTA_TABLE);
  const searchReady = Boolean(pg.search_installed);
  const postgresUser = typeof pg.pg_user === 'string' ? pg.pg_user : 'app service principal';
  return [
    { id: 'lakebase', label: 'Lakebase target', state: 'ready', detail: `Connected as ${postgresUser}` },
    { id: 'dbsql', label: 'DBSQL warehouse', state: dbsqlReady ? 'ready' : 'blocked', detail: dbsqlDetail },
    { id: 'catalog', label: 'Unity Catalog dataset', state: dbsqlReady ? 'ready' : 'blocked', detail: 'main.lakeload' },
    { id: 'cdf', label: 'Lakebase CDF', state: cdfReady ? 'ready' : 'action', detail: cdfReady ? process.env.CDF_DELTA_TABLE : 'Enable the preview, set REPLICA IDENTITY FULL, and activate CDF in the Lakebase UI.' },
    { id: 'sync', label: 'Synced table', state: process.env.SYNC_TABLE_NAME ? 'ready' : 'action', detail: process.env.SYNC_TABLE_NAME ?? 'Create the Delta-to-Lakebase synced table, then bind SELECT access to the app.' },
    { id: 'search', label: 'Lakebase Search', state: searchReady ? 'ready' : 'action', detail: searchReady ? 'Search extensions installed' : pg.search_available ? 'Available but not enabled. Enabling Search restarts compute and cannot be reversed.' : 'Search packages are not available in this project.' },
    { id: 'otel', label: 'OpenTelemetry', state: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? 'ready' : 'action', detail: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? 'OTLP exporter configured' : 'Configure an external OTLP collector in project settings.' },
  ];
}
