import type { Application, Request } from 'express';
import { createLakebasePool, getWorkspaceClient } from '@databricks/appkit';
import { z } from 'zod';
import { DbsqlEngine, type DbsqlRunConfig } from '../../lakeload/dbsql-engine';
import { LoadEngine, type RunConfig } from '../../lakeload/engine';
import { SCENARIOS, scenarioById, type ScenarioId } from '../../lakeload/scenarios';
import { WarehouseAnalyticsClient } from '../../lakeload/warehouse-analytics';

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface AppKitServices {
  lakebase: Queryable;
  analytics: { query(text: string, parameters?: Record<string, unknown>): Promise<unknown> };
  server: { extend(fn: (app: Application) => void): void };
}

interface SqlWarehouse {
  id: string;
  name: string;
  state: string;
  clusterSize: string;
  warehouseType: string;
  serverless: boolean;
}

type DestinationMode = 'existing-schema' | 'create-schema' | 'create-catalog-schema';

interface DataDestination {
  mode: DestinationMode;
  catalog: string;
  schema: string;
}

const RunRequest = z.object({
  scenario: z.string().refine((value): value is ScenarioId => scenarioById.has(value as ScenarioId)),
  concurrency: z.number().int().min(1).max(150),
  durationSeconds: z.number().int().min(10).max(600),
  rampSeconds: z.number().int().min(0).max(120),
  executionModel: z.enum(['closed', 'open']).default('closed'),
  targetRps: z.number().int().min(1).max(5_000).optional(),
});

const BranchRequest = z.object({
  kind: z.enum(['snapshot', 'restore']),
  sourceBranch: z.string().regex(/^projects\/[a-z0-9-]+\/branches\/[a-z0-9-]+$/),
  branchId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  createCompute: z.boolean().default(false),
});

const WarehouseRequest = z.object({
  warehouseId: z.string().regex(/^[a-zA-Z0-9-]{1,128}$/),
});

const CatalogIdentifier = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,254}$/);
const DataDestinationRequest = z.object({
  mode: z.enum(['existing-schema', 'create-schema', 'create-catalog-schema']),
  catalog: CatalogIdentifier,
  schema: CatalogIdentifier,
});

const HardResetRequest = z.object({
  confirmation: z.literal('RESET LAKELOAD'),
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
  ALTER TABLE lakeload_control.run_metric ADD COLUMN IF NOT EXISTS database_tps INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lakeload_control.run_metric ADD COLUMN IF NOT EXISTS commits INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lakeload_control.run_metric ADD COLUMN IF NOT EXISTS rollbacks INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lakeload_control.run_metric ADD COLUMN IF NOT EXISTS rows_inserted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lakeload_control.run_metric ADD COLUMN IF NOT EXISTS rows_updated INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lakeload_control.run_metric ADD COLUMN IF NOT EXISTS rows_deleted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lakeload_control.run_metric ADD COLUMN IF NOT EXISTS connections_active INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lakeload_control.run_metric ADD COLUMN IF NOT EXISTS connections_idle INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lakeload_control.run_metric ADD COLUMN IF NOT EXISTS connections_total INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lakeload_control.run_metric ADD COLUMN IF NOT EXISTS locks_waiting INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lakeload_control.run_metric ADD COLUMN IF NOT EXISTS locks_total INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lakeload_control.run_metric ADD COLUMN IF NOT EXISTS cache_hit_pct DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE lakeload_control.run_metric ADD COLUMN IF NOT EXISTS database_bytes BIGINT NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS run_metric_run_time_idx ON lakeload_control.run_metric(run_id, recorded_at);
  CREATE TABLE IF NOT EXISTS lakeload_control.branch_operation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), kind TEXT NOT NULL, branch_name TEXT NOT NULL,
    source_branch TEXT NOT NULL, operation_name TEXT, phase TEXT NOT NULL DEFAULT 'branch',
    create_compute BOOLEAN NOT NULL DEFAULT FALSE, status TEXT NOT NULL DEFAULT 'queued',
    message TEXT, requested_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS lakeload_control.app_setting (
    id INTEGER PRIMARY KEY CHECK (id = 1), sql_warehouse_id TEXT NOT NULL,
    updated_by TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE lakeload_control.app_setting ADD COLUMN IF NOT EXISTS data_catalog TEXT NOT NULL DEFAULT 'main';
  ALTER TABLE lakeload_control.app_setting ADD COLUMN IF NOT EXISTS data_schema TEXT NOT NULL DEFAULT 'lakeload';
  ALTER TABLE lakeload_control.app_setting ADD COLUMN IF NOT EXISTS destination_mode TEXT NOT NULL DEFAULT 'create-schema';
  CREATE TABLE IF NOT EXISTS lakeload_control.reset_operation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'queued',
    message TEXT NOT NULL DEFAULT 'Reset queued', branch_count INTEGER NOT NULL DEFAULT 0,
    requested_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
  );
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

function dbsqlSetup(namespace: string) {
  return [
    `CREATE TABLE IF NOT EXISTS ${namespace}.lakeload_account USING DELTA AS
   SELECT id, element_at(array('APAC','AMER','EMEA'), CAST(1 + pmod(id,3) AS INT)) AS region,
   CAST(10000 + pmod(id,5000) AS DECIMAL(14,2)) AS balance FROM range(1,1000001)`,
    `CREATE TABLE IF NOT EXISTS ${namespace}.lakeload_product USING DELTA AS
   SELECT id, element_at(array('Compute','Storage','AI','Platform'),CAST(1+pmod(id,4) AS INT)) AS category,
   concat('Product ',id) AS title, concat('Deterministic benchmark product ',id) AS description,
   CAST(5+pmod(id,995) AS DECIMAL(10,2)) AS price FROM range(1,10001)`,
    `CREATE TABLE IF NOT EXISTS ${namespace}.lakeload_history USING DELTA AS
   SELECT id, 1+pmod(id*7919,1000000) AS account_id,
   element_at(array('APAC','AMER','EMEA'),CAST(1+pmod(id,3) AS INT)) AS region,
   1+pmod(id*104729,1000000) AS counterparty_id, 1+pmod(id,10000) AS product_id,
   CAST((pmod(id,20001)-10000)/100.0 AS DECIMAL(10,2)) AS amount,
   timestampadd(SECOND,-pmod(id,2592000),current_timestamp()) AS created_at FROM range(1,5000001)`,
  ];
}

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
  await appkit.lakebase.query(
    `UPDATE lakeload_control.reset_operation SET status='failed', completed_at=NOW(),
     message='App restarted during hard reset; run it again to finish cleanup'
     WHERE status IN ('queued','running')`
  );
  const endpoint = process.env.TARGET_LAKEBASE_ENDPOINT;
  const defaultWarehouseId = process.env.DATABRICKS_WAREHOUSE_ID;
  let host = process.env.TARGET_PGHOST;
  const database = process.env.TARGET_PGDATABASE ?? 'databricks_postgres';
  if (!endpoint) throw new Error('TARGET_LAKEBASE_ENDPOINT is required');
  if (!defaultWarehouseId) throw new Error('DATABRICKS_WAREHOUSE_ID is required');
  await appkit.lakebase.query(
    `INSERT INTO lakeload_control.app_setting(id,sql_warehouse_id,updated_by)
     VALUES(1,$1,'deployment default') ON CONFLICT(id) DO NOTHING`,
    [defaultWarehouseId]
  );
  const storedSettings = await appkit.lakebase.query(
    `SELECT sql_warehouse_id,data_catalog,data_schema,destination_mode
     FROM lakeload_control.app_setting WHERE id=1`
  );
  const storedWarehouseId = storedSettings.rows[0]?.sql_warehouse_id;
  let selectedWarehouseId = typeof storedWarehouseId === 'string' ? storedWarehouseId : defaultWarehouseId;
  let selectedDataDestination: DataDestination = {
    mode: destinationMode(storedSettings.rows[0]?.destination_mode),
    catalog: stringField(storedSettings.rows[0]?.data_catalog, 'main'),
    schema: stringField(storedSettings.rows[0]?.data_schema, 'lakeload'),
  };
  const projectName = endpoint.split('/').slice(0, 2).join('/');
  const projectId = projectName.split('/')[1];
  const workspaceClient = getWorkspaceClient({});
  if (!host) {
    const endpointResource = (await workspaceClient.apiClient.request({
      path: `/api/2.0/postgres/${endpoint}`,
      method: 'GET',
      headers: new Headers(),
      raw: false,
    })) as { status?: { hosts?: { host?: string } } };
    host = endpointResource.status?.hosts?.host;
  }
  if (!host) throw new Error(`Lakebase host could not be resolved for ${endpoint}`);
  const warehouseAnalytics = new WarehouseAnalyticsClient(workspaceClient.apiClient, () => selectedWarehouseId);
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
  await ensureLakebaseBenchmarkSchema(targetPool);
  const lakebaseEngine = new LoadEngine(targetPool, appkit.lakebase);
  const dbsqlEngine = new DbsqlEngine(warehouseAnalytics, appkit.lakebase, () =>
    dataNamespace(selectedDataDestination)
  );
  let resetActiveId: string | null = null;
  let resetStarting = false;
  const resetBusy = () => resetStarting || Boolean(resetActiveId);
  let readinessCache: { updatedAt: number; value: Awaited<ReturnType<typeof getReadiness>> } | null = null;
  let branchesCache: Record<string, unknown>[] = [];
  let warehousesCache: { updatedAt: number; value: SqlWarehouse[] } | null = null;

  async function getWarehouses(force = false) {
    if (!force && warehousesCache && Date.now() - warehousesCache.updatedAt < 60_000) return warehousesCache.value;
    const response = await workspaceClient.apiClient.request({
      path: '/api/2.0/sql/warehouses',
      method: 'GET',
      headers: new Headers(),
      raw: false,
    });
    const value = collectionRows(response, 'warehouses')
      .map(toSqlWarehouse)
      .filter((item) => item.id);
    warehousesCache = { updatedAt: Date.now(), value };
    return value;
  }

  async function getCatalogs() {
    const response = await workspaceClient.apiClient.request({
      path: '/api/2.1/unity-catalog/catalogs',
      method: 'GET',
      query: { max_results: 100 },
      headers: new Headers(),
      raw: false,
    });
    return collectionRows(response, 'catalogs')
      .map((row) => stringField(row.name))
      .filter(Boolean)
      .sort();
  }

  async function getSchemas(catalog: string) {
    const response = await workspaceClient.apiClient.request({
      path: '/api/2.1/unity-catalog/schemas',
      method: 'GET',
      query: { catalog_name: catalog, max_results: 100 },
      headers: new Headers(),
      raw: false,
    });
    return collectionRows(response, 'schemas')
      .map((row) => stringField(row.name))
      .filter(Boolean)
      .sort();
  }

  async function performHardReset(resetId: string) {
    try {
      await updateReset(appkit.lakebase, resetId, 'running', 'Removing LakeLoad Delta benchmark tables');
      const namespace = dataNamespace(selectedDataDestination);
      for (const table of ['lakeload_history', 'lakeload_product', 'lakeload_account']) {
        await warehouseAnalytics.query(`DROP TABLE IF EXISTS ${namespace}.${quoteIdentifier(table)}`);
      }

      const branches = branchRows(
        await postgresRequest(workspaceClient, `/api/2.0/postgres/${projectName}/branches`, 'GET')
      ).filter(isLakeLoadTestBranch);
      await appkit.lakebase.query(
        `UPDATE lakeload_control.reset_operation SET branch_count=$2,
         message=$3 WHERE id=$1`,
        [resetId, branches.length, `Purging ${branches.length} LakeLoad snapshot and restore branches`]
      );
      await purgeLakeLoadTestBranches(workspaceClient, projectName, branches, async (message) => {
        await appkit.lakebase.query('UPDATE lakeload_control.reset_operation SET message=$2 WHERE id=$1', [
          resetId,
          message,
        ]);
      });

      await updateReset(appkit.lakebase, resetId, 'running', 'Clearing Lakebase benchmark tables');
      await targetPool.query(
        `TRUNCATE TABLE lakeload_bench.orders,lakeload_bench.history,lakeload_bench.product,
         lakeload_bench.account,lakeload_bench.dataset_marker RESTART IDENTITY CASCADE`
      );

      await updateReset(appkit.lakebase, resetId, 'running', 'Clearing run history and telemetry');
      await appkit.lakebase.query(
        `TRUNCATE TABLE lakeload_control.run_metric,lakeload_control.run,
         lakeload_control.branch_operation RESTART IDENTITY CASCADE`
      );
      await appkit.lakebase.query(
        `UPDATE lakeload_control.reset_operation SET status='completed',
         message='Hard reset complete. Prepare benchmark data to start clean tests.',completed_at=NOW() WHERE id=$1`,
        [resetId]
      );
      branchesCache = [];
      readinessCache = null;
    } catch (error) {
      console.error('[lakeload] hard reset failed', error);
      await appkit.lakebase.query(
        `UPDATE lakeload_control.reset_operation SET status='failed',message=$2,completed_at=NOW() WHERE id=$1`,
        [resetId, `Hard reset stopped: ${errorMessage(error)}`]
      );
    } finally {
      resetActiveId = null;
    }
  }

  const pendingOperations = await appkit.lakebase.query(
    `SELECT id, operation_name, phase, branch_name, create_compute FROM lakeload_control.branch_operation
     WHERE status IN ('queued','running') AND operation_name IS NOT NULL`
  );
  await appkit.lakebase.query(
    `UPDATE lakeload_control.branch_operation SET status='failed',completed_at=NOW(),
     message='App restarted before Lakebase operation tracking began; retry the branch action'
     WHERE status='queued' AND operation_name IS NULL`
  );
  for (const operation of pendingOperations.rows) {
    void monitorBranchOperation(appkit.lakebase, workspaceClient, operation).catch((error) =>
      failBranchOperation(appkit.lakebase, String(operation.id), error)
    );
  }

  appkit.server.extend((app) => {
    app.get('/api/lakeload/overview', async (_req, res) => {
      try {
        const [runs, target, operations, resets] = await Promise.all([
          appkit.lakebase.query(`${RUN_SELECT} ORDER BY created_at DESC LIMIT 50`),
          targetPool.query(`SELECT current_database() AS database, current_setting('server_version') AS postgres_version,
            (SELECT COUNT(*)::int FROM lakeload_bench.account) AS accounts,
            (SELECT COUNT(*)::int FROM lakeload_bench.product) AS products,
            (SELECT COUNT(*)::int FROM lakeload_bench.history) AS history_rows`),
          appkit.lakebase.query(
            `SELECT id,kind,branch_name,source_branch,phase,create_compute,status,message,requested_by,
                    created_at,completed_at FROM lakeload_control.branch_operation ORDER BY created_at DESC LIMIT 20`
          ),
          appkit.lakebase.query(
            `SELECT id,status,message,branch_count,requested_by,created_at,completed_at
             FROM lakeload_control.reset_operation ORDER BY created_at DESC LIMIT 1`
          ),
        ]);
        try {
          branchesCache = branchRows(
            await postgresRequest(workspaceClient, `/api/2.0/postgres/${projectName}/branches`, 'GET')
          );
        } catch (error) {
          // Control-plane telemetry must never interrupt the one-second workload metric stream.
          console.warn('[lakeload] branch topology refresh failed; serving the last known topology', error);
        }
        if (!readinessCache || Date.now() - readinessCache.updatedAt > 30_000) {
          readinessCache = {
            updatedAt: Date.now(),
            value: await getReadiness(
              targetPool,
              warehouseAnalytics,
              selectedWarehouseId,
              displayNamespace(selectedDataDestination),
              dataNamespace(selectedDataDestination)
            ),
          };
        }
        const selectedWarehouse = (await getWarehouses().catch(() => [])).find(
          (warehouse) => warehouse.id === selectedWarehouseId
        ) ?? {
          id: selectedWarehouseId,
          name: selectedWarehouseId,
          state: 'UNKNOWN',
          clusterSize: 'Unknown size',
          warehouseType: 'Unknown type',
          serverless: false,
        };
        const activeId = lakebaseEngine.activeRunId ?? dbsqlEngine.activeRunId;
        const metrics = activeId ? await metricsFor(appkit.lakebase, activeId) : { rows: [] };
        res.json({
          scenarios: SCENARIOS,
          runs: runs.rows,
          activeRunId: activeId,
          activeMetrics: metrics.rows,
          target: (target.rows[0] ?? {}) as Record<string, unknown>,
          readiness: readinessCache.value,
          branches: branchesCache,
          branchOperations: operations.rows,
          resetOperation: resets.rows[0] ?? null,
          sqlWarehouse: selectedWarehouse,
          dataDestination: selectedDataDestination,
          endpoint: {
            project: projectId,
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

    app.get('/api/lakeload/warehouses', async (_req, res) => {
      try {
        const warehouses = await getWarehouses(true);
        res.json({ warehouses, selectedWarehouseId });
      } catch (error) {
        res.status(500).json({ error: `Warehouses could not be listed: ${errorMessage(error)}` });
      }
    });

    app.get('/api/lakeload/data-destinations', async (req, res) => {
      try {
        const catalog = typeof req.query.catalog === 'string' ? req.query.catalog : selectedDataDestination.catalog;
        const parsedCatalog = CatalogIdentifier.safeParse(catalog);
        const [catalogs, schemas] = await Promise.all([
          getCatalogs(),
          parsedCatalog.success ? getSchemas(parsedCatalog.data).catch(() => []) : Promise.resolve([]),
        ]);
        res.json({ catalogs, schemas, selected: selectedDataDestination });
      } catch (error) {
        res.status(500).json({ error: `Data destinations could not be listed: ${errorMessage(error)}` });
      }
    });

    app.post('/api/lakeload/data-destination', async (req, res) => {
      const parsed = DataDestinationRequest.safeParse(req.body);
      if (!parsed.success)
        return void res.status(400).json({
          error: 'Catalog and schema names must start with a letter or underscore and use letters, numbers, _ or -.',
        });
      if (resetBusy()) return void res.status(409).json({ error: 'Hard reset is in progress' });
      if (lakebaseEngine.activeRunId || dbsqlEngine.activeRunId)
        return void res.status(409).json({ error: 'Stop the active benchmark before changing its data destination' });
      const destination = parsed.data;
      try {
        await validateDataDestination(warehouseAnalytics, destination);
        await appkit.lakebase.query(
          `UPDATE lakeload_control.app_setting SET data_catalog=$1,data_schema=$2,destination_mode=$3,
           updated_by=$4,updated_at=NOW() WHERE id=1`,
          [destination.catalog, destination.schema, destination.mode, actor(req)]
        );
        selectedDataDestination = destination;
        readinessCache = null;
        res.json({
          destination,
          message: `${displayNamespace(destination)} is now the DBSQL benchmark destination. Prepare data before testing.`,
        });
      } catch (error) {
        res.status(403).json({
          error: `Destination check failed: ${errorMessage(error)} Grant the App service principal the required catalog and schema privileges, then retry.`,
        });
      }
    });

    app.post('/api/lakeload/hard-reset', async (req, res) => {
      const parsed = HardResetRequest.safeParse(req.body);
      if (!parsed.success)
        return void res.status(400).json({ error: 'Type RESET LAKELOAD exactly to confirm the hard reset' });
      if (resetBusy()) return void res.status(409).json({ error: 'A hard reset is already in progress' });
      if (lakebaseEngine.activeRunId || dbsqlEngine.activeRunId)
        return void res.status(409).json({ error: 'Stop the active benchmark before hard reset' });
      resetStarting = true;
      try {
        await appkit.lakebase.query(
          `UPDATE lakeload_control.branch_operation SET status='failed',completed_at=NOW(),
           message='Branch request did not return a trackable Lakebase operation; retry the branch action'
           WHERE status='queued' AND operation_name IS NULL AND created_at < NOW() - INTERVAL '5 minutes'`
        );
        const branchWork = await appkit.lakebase.query(
          `SELECT 1 FROM lakeload_control.branch_operation WHERE status IN ('queued','running') LIMIT 1`
        );
        if (branchWork.rows.length > 0)
          return void res.status(409).json({ error: 'Wait for the active branch operation before hard reset' });
        const created = await appkit.lakebase.query(
          `INSERT INTO lakeload_control.reset_operation(status,message,requested_by)
           VALUES('queued','Hard reset queued',$1) RETURNING id`,
          [actor(req)]
        );
        resetActiveId = String(created.rows[0].id);
        void performHardReset(resetActiveId);
        res.status(202).json({ resetId: resetActiveId, status: 'queued' });
      } catch (error) {
        resetActiveId = null;
        res.status(500).json({ error: `Hard reset could not start: ${errorMessage(error)}` });
      } finally {
        resetStarting = false;
      }
    });

    app.post('/api/lakeload/warehouse', async (req, res) => {
      const parsed = WarehouseRequest.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: 'Invalid SQL warehouse ID' });
      if (resetBusy()) return void res.status(409).json({ error: 'Hard reset is in progress' });
      if (lakebaseEngine.activeRunId || dbsqlEngine.activeRunId)
        return void res.status(409).json({ error: 'Stop the active benchmark before changing SQL warehouse' });
      try {
        const warehouses = await getWarehouses(true);
        const selected = warehouses.find((warehouse) => warehouse.id === parsed.data.warehouseId);
        if (!selected)
          return void res.status(403).json({
            error: 'The App service principal cannot access that warehouse. Grant it CAN USE, then refresh the list.',
          });
        await warehouseAnalytics.queryWarehouse(selected.id, 'SELECT 1 AS lakeload_connection_test');
        await appkit.lakebase.query(
          `INSERT INTO lakeload_control.app_setting(id,sql_warehouse_id,updated_by,updated_at)
           VALUES(1,$1,$2,NOW()) ON CONFLICT(id) DO UPDATE SET
           sql_warehouse_id=EXCLUDED.sql_warehouse_id,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
          [selected.id, actor(req)]
        );
        selectedWarehouseId = selected.id;
        readinessCache = null;
        res.json({ warehouse: selected, message: `${selected.name} is now the DBSQL test warehouse.` });
      } catch (error) {
        res.status(500).json({ error: `Warehouse connection test failed: ${errorMessage(error)}` });
      }
    });

    app.post('/api/lakeload/setup', async (req, res) => {
      if (resetBusy()) return void res.status(409).json({ error: 'Hard reset is in progress' });
      try {
        await prepareLakebase(targetPool);
        await prepareLakebaseAnalyticalHistory(targetPool);
        await ensureDataDestination(warehouseAnalytics, selectedDataDestination);
        const namespace = dataNamespace(selectedDataDestination);
        for (const statement of dbsqlSetup(namespace)) await warehouseAnalytics.query(statement);
        const notebookPrincipal = actor(req);
        if (notebookPrincipal !== 'local-operator') {
          const quotedPrincipal = notebookPrincipal.replace(/`/g, '``');
          try {
            await warehouseAnalytics.query(
              `GRANT USE CATALOG ON CATALOG ${quoteIdentifier(selectedDataDestination.catalog)} TO \`${quotedPrincipal}\``
            );
            await warehouseAnalytics.query(`GRANT USE SCHEMA ON SCHEMA ${namespace} TO \`${quotedPrincipal}\``);
            for (const table of ['lakeload_account', 'lakeload_product', 'lakeload_history']) {
              await warehouseAnalytics.query(
                `GRANT SELECT ON TABLE ${namespace}.${quoteIdentifier(table)} TO \`${quotedPrincipal}\``
              );
            }
          } catch (error) {
            console.warn(
              '[lakeload] benchmark tables prepared but notebook grants require an owner or metastore admin',
              error
            );
          }
        }
        readinessCache = null;
        res.json({ status: 'ready', message: 'Lakebase and Delta benchmark datasets are ready.' });
      } catch (error) {
        res.status(500).json({ error: `Setup stopped: ${errorMessage(error)}` });
      }
    });

    app.post('/api/lakeload/branches', async (req, res) => {
      if (resetBusy()) return void res.status(409).json({ error: 'Hard reset is in progress' });
      const parsed = BranchRequest.safeParse(req.body);
      if (!parsed.success)
        return void res.status(400).json({ error: 'Invalid branch request', issues: parsed.error.issues });
      const input = parsed.data;
      if (!input.sourceBranch.startsWith(`${projectName}/branches/`))
        return void res.status(400).json({ error: 'Source branch must belong to the LakeLoad project' });
      const requiredPrefix = input.kind === 'snapshot' ? 'snapshot-' : 'restore-';
      if (!input.branchId.startsWith(requiredPrefix))
        return void res.status(400).json({ error: `${input.kind} branch IDs must start with ${requiredPrefix}` });
      let operationId: string | null = null;
      try {
        const branchName = `${projectName}/branches/${input.branchId}`;
        const existing = await appkit.lakebase.query(
          `SELECT 1 FROM lakeload_control.branch_operation WHERE branch_name=$1 AND status IN ('queued','running')`,
          [branchName]
        );
        if (existing.rows.length > 0)
          return void res.status(409).json({ error: 'A branch operation is already active for this name' });
        const created = await appkit.lakebase.query(
          `INSERT INTO lakeload_control.branch_operation
           (kind,branch_name,source_branch,create_compute,requested_by)
           VALUES($1,$2,$3,$4,$5) RETURNING id`,
          [input.kind, branchName, input.sourceBranch, input.createCompute, actor(req)]
        );
        operationId = String(created.rows[0].id);
        const operation = await postgresRequest(
          workspaceClient,
          `/api/2.0/postgres/${projectName}/branches`,
          'POST',
          { branch_id: input.branchId },
          {
            spec: {
              source_branch: input.sourceBranch,
              ...(input.kind === 'snapshot' ? { no_expiry: true } : { ttl: '86400s' }),
            },
          }
        );
        const operationName = operationNameFrom(operation);
        await appkit.lakebase.query(
          `UPDATE lakeload_control.branch_operation SET status='running',operation_name=$2,message=$3 WHERE id=$1`,
          [
            operationId,
            operationName,
            input.kind === 'snapshot' ? 'Capturing copy-on-write snapshot' : 'Restoring into an isolated branch',
          ]
        );
        void monitorBranchOperation(appkit.lakebase, workspaceClient, {
          id: operationId,
          operation_name: operationName,
          phase: 'branch',
          branch_name: branchName,
          create_compute: input.createCompute,
        }).catch((error) => failBranchOperation(appkit.lakebase, operationId ?? '', error));
        res.status(202).json({ operationId, branchName });
      } catch (error) {
        if (operationId) {
          await appkit.lakebase.query(
            `UPDATE lakeload_control.branch_operation SET status='failed',message=$2,completed_at=NOW() WHERE id=$1`,
            [operationId, `Branch operation could not start: ${errorMessage(error)}`]
          );
        }
        res.status(500).json({ error: `Branch operation could not start: ${errorMessage(error)}` });
      }
    });

    app.delete('/api/lakeload/branches/:branchId', async (req, res) => {
      if (resetBusy()) return void res.status(409).json({ error: 'Hard reset is in progress' });
      const branchId = req.params.branchId;
      if (!/^(snapshot|restore)-[a-z0-9-]+$/.test(branchId))
        return void res.status(400).json({ error: 'Only LakeLoad snapshot and restore branches can be removed here' });
      try {
        const operation = await postgresRequest(
          workspaceClient,
          `/api/2.0/postgres/${projectName}/branches/${branchId}`,
          'DELETE',
          { purge: false }
        );
        res.status(202).json({ operationName: operationNameFrom(operation) });
      } catch (error) {
        res.status(500).json({ error: `Branch could not be removed: ${errorMessage(error)}` });
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
      if (resetBusy()) return void res.status(409).json({ error: 'Hard reset is in progress' });
      const parsed = RunRequest.safeParse(req.body);
      if (!parsed.success)
        return void res.status(400).json({ error: 'Invalid run configuration', issues: parsed.error.issues });
      if (lakebaseEngine.activeRunId || dbsqlEngine.activeRunId)
        return void res.status(409).json({ error: 'Another run is active' });
      const definition = scenarioById.get(parsed.data.scenario as ScenarioId)!;
      if (!definition.runnable)
        return void res.status(409).json({
          error: `${definition.name} requires ${definition.prerequisite} setup. Use the readiness instructions first.`,
        });
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
            JSON.stringify({
              seed: 424242,
              catalog: selectedDataDestination.catalog,
              schema: selectedDataDestination.schema,
              endpoint: endpoint.split('/').slice(-1)[0],
              sql_warehouse_id: selectedWarehouseId,
              sql_warehouse_name:
                warehousesCache?.value.find((warehouse) => warehouse.id === selectedWarehouseId)?.name ??
                selectedWarehouseId,
            }),
          ]
        );
        const runId = String(created.rows[0].id);
        const task =
          definition.engine === 'dbsql'
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

type WorkspaceClient = ReturnType<typeof getWorkspaceClient>;

async function postgresRequest(
  workspaceClient: WorkspaceClient,
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  query?: Record<string, string | number | boolean>,
  payload?: unknown
) {
  return workspaceClient.apiClient.request({
    path,
    method,
    query,
    headers: new Headers(payload ? { 'Content-Type': 'application/json' } : undefined),
    raw: false,
    payload,
  });
}

function branchRows(response: unknown): Record<string, unknown>[] {
  return collectionRows(response, 'branches');
}

function collectionRows(response: unknown, key: string): Record<string, unknown>[] {
  const items = Array.isArray(response)
    ? response
    : response && typeof response === 'object' && key in response
      ? (response as Record<string, unknown>)[key]
      : [];
  return Array.isArray(items)
    ? items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : [];
}

function operationNameFrom(response: unknown) {
  if (!response || typeof response !== 'object' || !('name' in response) || typeof response.name !== 'string')
    throw new Error('Lakebase did not return an operation name');
  return response.name;
}

function booleanField(value: unknown) {
  return value === true || value === 'true';
}

function stringField(value: unknown, fallback = '') {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function destinationMode(value: unknown): DestinationMode {
  return value === 'existing-schema' || value === 'create-catalog-schema' ? value : 'create-schema';
}

function quoteIdentifier(value: string) {
  return `\`${value.replace(/`/g, '``')}\``;
}

function dataNamespace(destination: DataDestination) {
  return `${quoteIdentifier(destination.catalog)}.${quoteIdentifier(destination.schema)}`;
}

function displayNamespace(destination: DataDestination) {
  return `${destination.catalog}.${destination.schema}`;
}

async function ensureDataDestination(analytics: AppKitServices['analytics'], destination: DataDestination) {
  if (destination.mode === 'create-catalog-schema') {
    await analytics.query(`CREATE CATALOG IF NOT EXISTS ${quoteIdentifier(destination.catalog)}`);
  }
  if (destination.mode !== 'existing-schema') {
    await analytics.query(`CREATE SCHEMA IF NOT EXISTS ${dataNamespace(destination)}`);
  } else {
    await analytics.query(`DESCRIBE SCHEMA ${dataNamespace(destination)}`);
  }
}

async function validateDataDestination(analytics: AppKitServices['analytics'], destination: DataDestination) {
  await ensureDataDestination(analytics, destination);
  const namespace = dataNamespace(destination);
  const table = quoteIdentifier(`_lakeload_permission_check_${Date.now()}`);
  let created = false;
  try {
    await analytics.query(`CREATE TABLE ${namespace}.${table} USING DELTA AS SELECT 1 AS permission_check`);
    created = true;
  } finally {
    if (created) await analytics.query(`DROP TABLE ${namespace}.${table}`);
  }
}

function toSqlWarehouse(row: Record<string, unknown>): SqlWarehouse {
  return {
    id: stringField(row.id),
    name: stringField(row.name, stringField(row.id)),
    state: stringField(row.state, 'UNKNOWN'),
    clusterSize: stringField(row.cluster_size, 'Unknown size'),
    warehouseType: stringField(row.warehouse_type, 'Unknown type'),
    serverless: booleanField(row.enable_serverless_compute),
  };
}

function lakeLoadTestBranchId(branch: Record<string, unknown>) {
  const status = branch.status && typeof branch.status === 'object' ? (branch.status as Record<string, unknown>) : {};
  return stringField(status.branch_id, stringField(branch.name).split('/').slice(-1)[0] ?? '');
}

export function isLakeLoadTestBranch(branch: Record<string, unknown>) {
  return /^(snapshot|restore)-[a-z0-9-]+$/.test(lakeLoadTestBranchId(branch));
}

async function purgeLakeLoadTestBranches(
  workspaceClient: WorkspaceClient,
  projectName: string,
  branches: Record<string, unknown>[],
  onProgress: (message: string) => Promise<void>
) {
  const ordered = [...branches].sort((left, right) => {
    const leftRestore = lakeLoadTestBranchId(left).startsWith('restore-') ? 0 : 1;
    const rightRestore = lakeLoadTestBranchId(right).startsWith('restore-') ? 0 : 1;
    return leftRestore - rightRestore;
  });
  for (let index = 0; index < ordered.length; index += 1) {
    const branchId = lakeLoadTestBranchId(ordered[index]);
    await onProgress(`Purging branch ${index + 1} of ${ordered.length}: ${branchId}`);
    const operation = await postgresRequest(
      workspaceClient,
      `/api/2.0/postgres/${projectName}/branches/${branchId}`,
      'DELETE',
      { purge: true }
    );
    await waitForPostgresOperation(workspaceClient, operationNameFrom(operation));
  }
}

async function waitForPostgresOperation(workspaceClient: WorkspaceClient, operationName: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const operation = await postgresRequest(workspaceClient, `/api/2.0/postgres/${operationName}`, 'GET');
    const record = operation && typeof operation === 'object' ? (operation as Record<string, unknown>) : {};
    if (record.done === true) {
      if (record.error) throw new Error(`Branch purge failed: ${JSON.stringify(record.error)}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Branch purge operation ${operationName} exceeded five minutes`);
}

async function updateReset(control: Queryable, id: string, status: string, message: string) {
  await control.query('UPDATE lakeload_control.reset_operation SET status=$2,message=$3 WHERE id=$1', [
    id,
    status,
    message,
  ]);
}

async function monitorBranchOperation(
  control: Queryable,
  workspaceClient: WorkspaceClient,
  operationRow: Record<string, unknown>
) {
  const id = String(operationRow.id);
  const branchName = String(operationRow.branch_name);
  let phase = stringField(operationRow.phase, 'branch');
  let operationName = stringField(operationRow.operation_name);
  const createCompute = booleanField(operationRow.create_compute);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const operation = await postgresRequest(workspaceClient, `/api/2.0/postgres/${operationName}`, 'GET');
    const record = operation && typeof operation === 'object' ? (operation as Record<string, unknown>) : {};
    if (record.done === true) {
      if (record.error) {
        const message =
          record.error && typeof record.error === 'object'
            ? JSON.stringify(record.error)
            : stringField(record.error, 'Lakebase operation failed');
        await control.query(
          `UPDATE lakeload_control.branch_operation SET status='failed',message=$2,completed_at=NOW() WHERE id=$1`,
          [id, message]
        );
        return;
      }
      if (phase === 'branch' && createCompute) {
        const endpoints = collectionRows(
          await postgresRequest(workspaceClient, `/api/2.0/postgres/${branchName}/endpoints`, 'GET'),
          'endpoints'
        );
        if (endpoints.length > 0) {
          await control.query(
            `UPDATE lakeload_control.branch_operation SET status='completed',phase='compute',
             message='Restore branch and dedicated compute are ready',completed_at=NOW() WHERE id=$1`,
            [id]
          );
          return;
        }
        const endpointOperation = await postgresRequest(
          workspaceClient,
          `/api/2.0/postgres/${branchName}/endpoints`,
          'POST',
          { endpoint_id: 'primary' },
          {
            spec: {
              endpoint_type: 'ENDPOINT_TYPE_READ_WRITE',
              autoscaling_limit_min_cu: 0.5,
              autoscaling_limit_max_cu: 1,
              suspend_timeout_duration: '300s',
            },
          }
        );
        operationName = operationNameFrom(endpointOperation);
        phase = 'compute';
        await control.query(
          `UPDATE lakeload_control.branch_operation SET phase='compute',operation_name=$2,
           message='Starting isolated restore compute' WHERE id=$1`,
          [id, operationName]
        );
        continue;
      }
      await control.query(
        `UPDATE lakeload_control.branch_operation SET status='completed',message=$2,completed_at=NOW() WHERE id=$1`,
        [id, phase === 'compute' ? 'Restore branch and compute are ready' : 'Snapshot branch is ready']
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  await control.query(
    `UPDATE lakeload_control.branch_operation SET status='failed',message='Operation exceeded the five-minute monitor window',
     completed_at=NOW() WHERE id=$1`,
    [id]
  );
}

async function failBranchOperation(control: Queryable, id: string, error: unknown) {
  console.error('[lakeload] branch operation failed', error);
  if (!id) return;
  try {
    await control.query(
      `UPDATE lakeload_control.branch_operation SET status='failed',message=$2,completed_at=NOW() WHERE id=$1`,
      [id, errorMessage(error)]
    );
  } catch (updateError) {
    console.error('[lakeload] could not persist branch operation failure', updateError);
  }
}

async function metricsFor(control: Queryable, runId: string) {
  return control.query(
    `SELECT recorded_at,elapsed_seconds,active_users,operations,errors,reads,writes,
    complex_queries,p50_ms,p95_ms,p99_ms,database_tps,commits,rollbacks,rows_inserted,rows_updated,
    rows_deleted,connections_active,connections_idle,connections_total,locks_waiting,locks_total,
    cache_hit_pct,database_bytes FROM lakeload_control.run_metric WHERE run_id=$1 ORDER BY recorded_at`,
    [runId]
  );
}

async function ensureLakebaseBenchmarkSchema(target: Queryable) {
  await target.query(BENCHMARK_SCHEMA_SQL);
}

async function prepareLakebase(target: Queryable) {
  await ensureLakebaseBenchmarkSchema(target);
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

async function prepareLakebaseAnalyticalHistory(target: Queryable) {
  await target.query(`INSERT INTO lakeload_bench.history(id,account_id,counterparty_id,amount,created_at)
    SELECT id,1+MOD(id::bigint*7919,10000),1+MOD(id::bigint*104729,10000),
           ((MOD(id,20001)-10000)/100.0)::numeric(10,2),
           NOW()-(MOD(id::bigint,2592000) * INTERVAL '1 second')
    FROM generate_series(1,5000000) id
    ON CONFLICT(id) DO NOTHING`);
  await target.query(`SELECT setval(pg_get_serial_sequence('lakeload_bench.history','id'),
    GREATEST((SELECT COALESCE(MAX(id),1) FROM lakeload_bench.history),1),true)`);
  await target.query('ANALYZE lakeload_bench.history');
}

async function getReadiness(
  target: Queryable,
  analytics: AppKitServices['analytics'],
  warehouseId?: string,
  destination = 'main.lakeload',
  namespace = '`main`.`lakeload`'
) {
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
  let dbsqlDetail = warehouseId ? `Warehouse ${warehouseId} connected` : 'Warehouse connected';
  try {
    await analytics.query('SELECT 1 AS ready');
  } catch (error) {
    dbsqlReady = false;
    dbsqlDetail = errorMessage(error);
  }
  let catalogReady = dbsqlReady;
  if (dbsqlReady) {
    try {
      await analytics.query(`SELECT 1 FROM ${namespace}.lakeload_account LIMIT 1`);
    } catch {
      catalogReady = false;
    }
  }
  const pg = checks.rows[0] ?? {};
  const cdfReady = Boolean(pg.cdf_installed && pg.replica_identity_full && process.env.CDF_DELTA_TABLE);
  const searchReady = Boolean(pg.search_installed);
  const postgresUser = typeof pg.pg_user === 'string' ? pg.pg_user : 'app service principal';
  return [
    { id: 'lakebase', label: 'Lakebase target', state: 'ready', detail: `Connected as ${postgresUser}` },
    { id: 'dbsql', label: 'DBSQL warehouse', state: dbsqlReady ? 'ready' : 'blocked', detail: dbsqlDetail },
    {
      id: 'catalog',
      label: 'Unity Catalog destination',
      state: catalogReady ? 'ready' : 'action',
      detail: catalogReady ? destination : `${destination} selected; prepare benchmark data`,
    },
    {
      id: 'cdf',
      label: 'Lakebase CDF',
      state: cdfReady ? 'ready' : 'action',
      detail: cdfReady
        ? process.env.CDF_DELTA_TABLE
        : 'Enable the preview, set REPLICA IDENTITY FULL, and activate CDF in the Lakebase UI.',
    },
    {
      id: 'sync',
      label: 'Synced table',
      state: process.env.SYNC_TABLE_NAME ? 'ready' : 'action',
      detail:
        process.env.SYNC_TABLE_NAME ?? 'Create the Delta-to-Lakebase synced table, then bind SELECT access to the app.',
    },
    {
      id: 'search',
      label: 'Lakebase Search',
      state: searchReady ? 'ready' : 'action',
      detail: searchReady
        ? 'Search extensions installed'
        : pg.search_available
          ? 'Available but not enabled. Enabling Search restarts compute and cannot be reversed.'
          : 'Search packages are not available in this project.',
    },
    {
      id: 'otel',
      label: 'OpenTelemetry',
      state: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? 'ready' : 'action',
      detail: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? 'OTLP exporter configured'
        : 'Configure an external OTLP collector in project settings.',
    },
  ];
}
