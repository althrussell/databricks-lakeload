# LakeLoad customer guide

LakeLoad is a repeatable Databricks App for demonstrating Lakebase OLTP, DBSQL OLAP, and bidirectional LTAP. It creates deterministic operational and Delta datasets, runs measured workloads, and keeps engine guidance beside each result.

## What gets installed

- One Lakebase Autoscaling project with a protected-style `production` control branch and an isolated `benchmark` branch.
- A Databricks App whose service principal owns `lakeload_control` and `lakeload_bench` PostgreSQL schemas.
- One serverless Lakeflow Job runner for distributed Lakebase load.
- One DBSQL warehouse binding for Delta setup and OLAP scenarios.
- One executable DBSQL-versus-Lakebase notebook job.
- A copy-on-write Branch Lab for live snapshots and isolated restore branches.
- PostgreSQL tables in `lakeload_bench`: `account` (1 million rows), `product` (10,000 rows), and `history` (5 million rows).
- Delta tables in `<catalog>.lakeload`: `account` (1 million rows), `product` (10,000 rows), and `history` (5 million rows).

No database password is stored. The App and jobs mint short-lived OAuth database credentials.

## Install from GitHub

Prerequisites:

1. Databricks CLI 0.218 or later with an authenticated workspace profile.
2. Python 3.10 or later with `databricks-sdk` installed.
3. Permission to create Lakebase Autoscaling projects and Databricks Apps.
4. `CAN_USE` on a running SQL warehouse.
5. `USE CATALOG` and `CREATE SCHEMA` on the selected Unity Catalog catalog, or an administrator who can grant them to the App service principal.

Run:

```bash
git clone https://github.com/althrussell/databricks-lakeload.git
cd databricks-lakeload
npm ci
python scripts/bootstrap.py \
  --profile <workspace-profile> \
  --warehouse <warehouse-id> \
  --catalog main
```

The installer is idempotent. It creates or reuses the Lakebase project, benchmark branch, 1–4 CU endpoint, app, jobs, and resource grants. It prints the App URL when deployment succeeds.

Open the App and select **Settings**. **Benchmark destinations** shows the fixed Lakebase database and configures the Unity Catalog location used by DBSQL. Choose one setup path:

- **Use an existing schema** when the App service principal already has `USE CATALOG`, `USE SCHEMA`, and `CREATE TABLE`.
- **Create a schema in an existing catalog** when catalog creation is restricted but the App can create schemas in an approved catalog.
- **Create a catalog and schema** when the App service principal has `CREATE CATALOG`.

LakeLoad validates the destination by creating and removing a permission-check Delta table before saving it. It creates only `lakeload_account`, `lakeload_product`, `lakeload_history`, and the synced-table source `lakeload_serving_profile`, so an existing schema can contain other objects safely.

Under **SQL warehouse under test**, choose the DBSQL warehouse and select **Use for DBSQL tests**. Then select **Prepare benchmark data**. Initial preparation normally takes 1–2 minutes; an idempotent rerun in the `labs` environment took about 25 seconds.

The selector lists warehouses visible to the App service principal. The warehouse declared during installation is available automatically. To test another warehouse, grant the LakeLoad App service principal `CAN USE` on it and reopen Settings. The selected ID is persisted in the control database, included in every run manifest, and used for DBSQL setup, standalone workloads, and paired comparisons.

### Start again with a clean environment

Open **Settings > Hard reset** when the demo environment must be returned to an empty state. The confirmation dialog requires the exact phrase `RESET LAKELOAD`. Reset runs asynchronously and its current phase remains visible in Settings.

Hard Reset permanently removes only LakeLoad-owned test artifacts:

- every row in the dedicated `lakeload_bench` PostgreSQL tables;
- the three `lakeload_*` Delta benchmark tables in the selected catalog and schema;
- all run manifests, one-second metrics, and branch-operation history;
- branches whose IDs match `snapshot-*` or `restore-*`, purged child restores before snapshots.

It preserves the selected catalog and schema, every non-LakeLoad table, the Lakebase project, `production` and `benchmark` branches, database and compute resources, App deployment, and selected SQL warehouse. Active loads and branch operations must finish or be stopped first. When the status reads **Ready for a clean start**, select **Prepare benchmark data** before launching another test.

### Why installation has a bootstrap command

A Databricks App cannot create and bind the Lakebase project that authenticates the App before the App service principal exists. The installer resolves this dependency in two phases: create Lakebase, deploy the App, then grant the new App service principal scoped catalog rights. After that, every data preparation and test action is initiated in the App.

## Readiness states

The Setup page performs live checks.

| State          | Meaning                                                                                                  | Operator action                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Ready          | The App can use the capability now.                                                                      | None.                                                           |
| Setup required | The workspace supports the feature but an administrator must complete a preview or project-level action. | Follow the detail shown in the row and the feature steps below. |
| Blocked        | A required resource cannot be reached.                                                                   | Correct the binding or permission, then reload.                 |

Preview features remain disabled until the readiness check passes. LakeLoad never enables an irreversible feature or restarts a project without an operator decision.

## Scenario catalog

### OLTP: Lakebase

#### Indexed point lookup

- Question: How does latency behave as concurrent application sessions rise?
- Query: parameterized primary-key lookups against `lakeload_bench.account`.
- Run: closed-loop sweeps at 1, 10, 50, 100, and 150 users; then open-loop arrival rates until p99 or errors rise.
- Record: ops/s, p50, p95, p99, errors, active sessions, CU range, warm/cold state.
- Interpretation: this is the application-serving case Lakebase is designed for.

#### Transactional transfer

- Question: Can the database sustain multi-statement writes while preserving an invariant?
- Transaction: debit one account, credit another, and insert an audit row before commit.
- Verification: call `POST /api/lakeload/verify-invariant`; total balance must remain `124995000.00` and no account should be negative for the supplied workload.
- Interpretation: atomicity and row-level concurrency matter more than scan speed.

#### Mixed application traffic

- Question: What happens when 55% reads, 35% transfers, and 10% bounded joins share the endpoint?
- Run: 30–60 seconds for demos; at least 5 minutes for capacity observations.
- Interpretation: use this as the representative application benchmark, not the single-query microbenchmarks.

#### Operational join

- Question: How quickly can the application join the current entity to a bounded recent-history window?
- Query: one account joined through the account/time index to its latest 20 audit events, grouped by region.
- Interpretation: bounded operational joins belong close to mutable state. Large historical scans do not.

### OLAP: DBSQL

#### Delta point lookup

- Question: What overhead appears when an analytical engine serves one application lookup at a time?
- Query: one ID filter over `<catalog>.<schema>.lakeload_account`.
- Interpretation: DBSQL can answer this query, but warehouse scheduling and analytical execution are not a substitute for an OLTP request path.

#### Large analytical scan

- Question: Which engine should scan, join, and aggregate a large fact table?
- Query: scan five million history rows, join products, aggregate events, amount, and approximate active accounts by region and category.
- Interpretation: DBSQL supplies parallel scans and analytical operators without consuming operational endpoint capacity.

#### Windowed customer ranking

- Question: Where should wide window functions over customer history run?
- Query: aggregate account history and rank accounts within region.
- Interpretation: this is an OLAP workload. Keep it in DBSQL and return only the curated result needed by the application.

### LTAP

#### Lakebase CDF freshness

- Write a uniquely tagged order in Lakebase and record the PostgreSQL commit timestamp.
- Poll the configured Delta CDF destination for the tag.
- Record commit-to-Delta lag, duplicates, ordering fields, and before/after image semantics.
- Run updates and deletes as well as inserts.
- Validate retry behavior and consumer idempotency.

#### Synced-table serving

- Update one curated profile or score in Delta and record the Delta commit version and timestamp.
- Poll the Lakebase synced table until the value is visible.
- Record Delta-to-Lakebase freshness, indexed point-lookup p50/p95/p99, and sync pipeline state.
- Treat the synced table as system-owned and read-mostly. Do not mutate it from the application.

#### Closed-loop order enrichment

1. Lakebase commits an order.
2. Lakebase CDF writes the operational change to Delta.
3. DBSQL joins the order to historical behavior and computes a risk or recommendation score.
4. A synced table returns the curated score to Lakebase.
5. Checkout reads the score beside the mutable order.

Record timestamps at every boundary. Report commit-to-Delta, DBSQL processing, Delta-to-Lakebase, and total end-to-end lag separately.

### Lakebase Search

#### Keyword search

Rank title and description matches with `lakebase_text`. Measure concurrent query latency and validate exact filters such as category, price, and availability.

#### Vector search

Load deterministic embeddings, create the supported vector index, and measure nearest-neighbor retrieval beside relational filters.

#### Hybrid RRF search

Execute keyword and vector candidates, combine ranks with reciprocal rank fusion, and compare relevance plus latency with either method alone.

### OpenTelemetry correlation

Attach the immutable LakeLoad run ID, scenario ID, engine, and operation to trace attributes. During a concurrency or target-rate sweep, correlate throughput and p99 intervals with request spans and database spans. Telemetry is diagnostic context; the runner's measured histograms remain authoritative.

## Configure preview features

### Lakebase CDF

Official guide: [Lakebase CDF](https://docs.databricks.com/aws/en/oltp/projects/lakebase-cdf)

1. Ask a workspace administrator to enable the Lakebase CDF preview.
2. Press **Prepare benchmark data**. LakeLoad sets full row images on every table in `lakeload_bench`; the equivalent manual commands include:

   ```sql
   ALTER TABLE lakeload_bench.account REPLICA IDENTITY FULL;
   ALTER TABLE lakeload_bench.product REPLICA IDENTITY FULL;
   ALTER TABLE lakeload_bench.history REPLICA IDENTITY FULL;
   ALTER TABLE lakeload_bench.orders REPLICA IDENTITY FULL;
   ```

3. Open `projects/lakeload`, select the `benchmark` branch, open **Lakebase CDF**, and click **Start**.
4. Select source database `databricks_postgres`, source schema `lakeload_bench`, and destination `main.lakeload` (or the catalog/schema selected in LakeLoad Settings).
5. Wait for `lb_orders_history` to reach **Streaming**, then reload LakeLoad Settings. The expected lab table is `main.lakeload.lb_orders_history`.

CDF is schema-scoped: current and future non-empty tables in `lakeload_bench` are captured as `lb_<table>_history`. The destination catalog must not use Unity Catalog default storage. The configuring identity needs `USE CATALOG`, `USE SCHEMA`, and `CREATE TABLE` on the destination.

CDF activation is currently a UI operation. It is not safe for the installer to guess a destination or preview setting.

### Synced tables

Official guide: [Sync tables to Lakebase](https://docs.databricks.com/aws/en/oltp/projects/sync-tables)

1. Run `scripts/bootstrap.py`, then press **Prepare benchmark data**. LakeLoad creates the Delta source `<destination>.lakeload_serving_profile`, enables Delta CDF, and provisions a continuous sync automatically.
2. Confirm the resource `synced_tables/lakeload_pg.lakeload_sync.serving_profile` is **ONLINE**. The target is `projects/lakeload/branches/benchmark`, database `databricks_postgres`.
3. Run **Delta → Lakebase serving freshness**. Each cycle updates a version token in Delta and waits until that exact value is queryable from `lakeload_sync.serving_profile`.
4. Treat the PostgreSQL table as pipeline-owned and read-only. It is owned by the internal `databricks_writer_<dbid>` role; direct writes are not an application persistence mechanism and are overwritten or repopulated by refresh.

Each continuous synced table can use up to 16 Lakebase connections. Continuous and triggered modes require Delta CDF. If an installer chooses a different registered Lakebase catalog ID, set `LAKELOAD_LAKEBASE_CATALOG` consistently before deployment.

### Lakebase Search

Official guide: [Lakebase Search](https://docs.databricks.com/aws/en/oltp/projects/lakebase-search)

1. Confirm `lakebase_text` and `lakebase_vector` appear in `pg_available_extensions`.
2. Review the project restart and irreversibility warning with the operator.
3. Open `projects/lakeload` → **Settings** → **Lakebase Search** → **Enable Lakebase Search** during a maintenance window.
4. Wait for every project compute to restart, then press **Prepare benchmark data**. LakeLoad installs `lakebase_vector` and `lakebase_text`, creates a deterministic 10,000-document corpus, and builds ANN and BM25 indexes on the benchmark branch.
5. Reload Settings. Search is ready only after both extensions and the corpus probe succeed; then run keyword, vector, and hybrid RRF scenarios.

Do not enable Search as part of unattended installation. Enabling it restarts compute and cannot be reversed for the project.

### Advanced Postgres telemetry to Delta

Official guides: [capture telemetry](https://docs.databricks.com/aws/en/oltp/projects/observability-capture) and [telemetry table reference](https://docs.databricks.com/aws/en/oltp/projects/observability-telemetry-reference)

1. Enable the **Lakebase Advanced Postgres Telemetry** workspace preview.
2. Create the chosen destination schema first. For the lab, use `main.lakeload` and leave the optional table prefix empty so LakeLoad can probe the documented names directly.
3. In the Observability configuration, select `projects/lakeload`, choose an export identity, and grant it `USE CATALOG`, `USE SCHEMA`, and `CREATE TABLE` on the destination.
4. For a short lab test, user-level credentials avoid expanding the App service principal's authority. A durable shared service principal currently also requires workspace access, `CAN USE`, and membership in the workspace `admins` group because of a Beta constraint; this is an explicit administrator decision and the bootstrap script does not make it.
5. Restart an already-running compute after enabling observability, then verify `pg_stat_statements_counters`, `active_session_history`, and `plan_history` contain rows. LakeLoad also expects the broader export surface (`wait_event_counters`, `ddl_history`, `postgres_logs`, `compute_counters`, `compute_gauges`, `database_counters`, and `database_gauges`) for customer investigation.
6. Run **Advanced telemetry diagnosis** to connect a high-p99 interval to query counters, waits, and plan evidence.

### OpenTelemetry

Official guide: [Lakebase OpenTelemetry](https://docs.databricks.com/aws/en/oltp/projects/opentelemetry)

1. Provision an OTLP-compatible collector that the Lakebase project can reach.
2. In `projects/lakeload` → **Settings** → **Integrations**, configure the exporter base URL and authentication. Lakebase operates the managed collector; the customer supplies the reachable OTLP backend.
3. Set `OTEL_EXPORTER_OTLP_ENDPOINT` for the App and runner if application spans should use the same collector.
4. Redact SQL literals and credentials according to customer policy.
5. Run a short benchmark and confirm the LakeLoad run ID appears in the trace backend before a presentation.

LakeLoad does not provision an external collector.

## Run a fair comparison

1. Prepare data once from Setup.
2. Record the Lakebase endpoint CU minimum/maximum, DBSQL warehouse size, runner location, data scale, seed, and Git commit.
3. Keep the default five-second warm-up or choose zero to include first-query startup. Warm-up remains visible but is excluded from headline metrics.
4. Run at least three measured repetitions in the same cache state.
5. Use the same logical question, not necessarily identical physical SQL. A bounded operational query and a historical analytical query are different workloads.
6. Report median throughput plus p50, p95, p99, errors, and freshness. Do not average p99 values across workers.
7. Label cold-start and scale-to-zero measurements separately.
8. Stop when the error guardrail is crossed. Saturation is a result, not a reason to keep increasing load.

## Use the side-by-side engine comparison

Open **Compare engines** in the navigation rail. Each preset applies one concurrency, duration, ramp, execution model, and warm-state policy to both lanes. LakeLoad runs the engines sequentially so one client workload does not interfere with the other, streams each lane at one-second resolution, then keeps both recorded timelines visible together.

- **Indexed request serving** issues the same account-and-product lookup over the same 1M/10K key ranges. Use throughput and p95/p99 to explain why Lakebase belongs on the synchronous OLTP request path.
- **Five-million-row scan and join** makes both engines scan five million fact rows, join account and product dimensions, and aggregate by region and category. Use completed analytical queries and latency to explain DBSQL's OLAP execution fit.
- **Transactions beside analytics** deliberately runs different workloads: mixed application traffic in Lakebase and a wide scan in DBSQL. It is an architecture demonstration, not a speed comparison.

For a customer measurement, select a preset, set the shared controls, choose **3-pass evidence**, and run the suite. Hover any chart for exact values, phase, and change. LakeLoad refuses to select a winner when pair fingerprints differ. Quote a result only after three runs per engine, then download the JSON evidence package and metric CSV.

## Read the real-time console

Every graph is driven by the same approximately one-second stream. Each sample records its actual width, so rates remain correct when polling or a diagnostic query takes slightly longer. The Branch Lab consumes that stream while control-plane operations are in progress.

Hover any graph to inspect an exact one-second sample. The crosshair readout shows the sample time, each series value, and its percentage change from the previous sample. Keyboard users can focus a graph, move through samples with Left/Right Arrow, and press Escape to close the readout.

| Metric                            | Meaning                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Completed ops/s                   | Successful completions normalized by actual sample width.                                                                                              |
| Offered ops/s                     | Arrivals attempted by target-rate scheduling, normalized by actual sample width.                                                                        |
| Admission drops                   | Arrivals not started because the configured in-flight client limit was full.                                                                            |
| Query errors                      | Admitted operations that returned an engine error.                                                                                                      |
| Database tx/s                     | PostgreSQL commits plus rollbacks normalized by database-stat sample width. It is endpoint context, not an exact workload counter.                      |
| p50 / p95 / p99                   | Exact nearest-rank latency of successful operations as observed by the load generator.                                                                  |
| Active / idle / total connections | Current PostgreSQL sessions for the benchmark database.                                                                                                |
| Inserted / updated / deleted      | PostgreSQL row-change counters sampled as interval deltas.                                                                                             |
| Cache hit                         | Current PostgreSQL block cache hit ratio.                                                                                                              |
| Waiting locks                     | Locks not granted at sample time; use this beside p99 to identify contention.                                                                          |

The charts show `1s LIVE` only while a run is active. Completed runs are explicitly labelled `RECORDED`. Lakebase-only database statistics should not be interpreted as DBSQL engine telemetry during a DBSQL run.

## Demonstrate snapshot and restore under load

1. Start **Mixed application traffic** for 60 seconds or longer.
2. Open **Branch lab** while the TPS and latency charts are moving. Navigation does not stop the run.
3. Select **Capture snapshot**. The operation stream and lineage poll every second while workload graphs continue updating.
4. Select the completed `snapshot-*` node.
5. Select **Restore isolated branch**. LakeLoad creates a `restore-*` branch and verifies its dedicated read-write compute. If the platform does not clone an endpoint with the branch, LakeLoad creates a 0.5–1 CU endpoint.
6. Use the live graphs to show that benchmark traffic continued throughout both operations.
7. Remove a disposable `restore-*` branch from its trash action when finished.

LakeLoad never resets or overwrites `benchmark`. Restore means “create a new isolated branch from this snapshot.” The App only allows deletion of branches it recognizes by the `snapshot-*` or `restore-*` prefix; the UI exposes deletion only for disposable restore branches.

Recommended demo sequence:

1. Lakebase point lookup at 1, 10, 50, 100, and 150 users.
2. Lakebase transfer test followed by invariant verification.
3. Mixed Lakebase traffic at 50 users.
4. DBSQL Delta point lookup to illustrate analytical-serving overhead.
5. DBSQL large scan and window scenarios to show the correct OLAP fit.
6. Execute the comparison notebook and discuss conditions, not only elapsed time.
7. If previews are ready, demonstrate CDF freshness, synced serving, then the complete LTAP loop.
8. If Search and an OTLP collector are ready, finish with hybrid retrieval and trace correlation.

## Execute the comparison notebook

The bundle deploys the job **`[default] LakeLoad DBSQL vs Lakebase notebook`**. Run it from Workflows or with:

```bash
databricks bundle run comparison_notebook -p <profile> -t default
```

The source is `notebooks/dbsql_vs_lakebase.py`. It uses the SQL Statement Execution API for DBSQL and PostgreSQL OAuth for Lakebase. The output tables include iterations, mean, p50, p95, p99, and cache-state label.

## API automation

The App UI uses these routes, which are also useful for a smoke harness:

```text
GET    /api/lakeload/overview
GET    /api/lakeload/warehouses
GET    /api/lakeload/data-destinations
POST   /api/lakeload/warehouse
POST   /api/lakeload/data-destination
POST   /api/lakeload/hard-reset
POST   /api/lakeload/setup
POST   /api/lakeload/runs
GET    /api/lakeload/runs/{run_id}
DELETE /api/lakeload/runs/{run_id}
POST   /api/lakeload/verify-invariant
POST   /api/lakeload/branches
DELETE /api/lakeload/branches/{branch_id}
```

Example run body:

```json
{
  "scenario": "lakebase-point-lookup",
  "concurrency": 50,
  "durationSeconds": 30,
  "rampSeconds": 5,
  "executionModel": "closed"
}
```

For an open-loop saturation test, set `executionModel` to `open` and add `targetRps`.

Snapshot request:

```json
{
  "kind": "snapshot",
  "sourceBranch": "projects/lakeload/branches/benchmark",
  "branchId": "snapshot-demo01",
  "createCompute": false
}
```

A restore request uses `kind: "restore"`, the full snapshot resource name as `sourceBranch`, a `restore-*` branch ID, and `createCompute: true`.

## Troubleshooting

- **DBSQL readiness is blocked:** open Settings and confirm the selected warehouse. The `sql-warehouse` App resource or an explicit grant must give the App service principal `CAN USE`. LakeLoad starts serverless warehouses through the first statement; start a non-serverless warehouse if its policy requires it.
- **Unity Catalog setup stops:** grant `USE CATALOG` and `CREATE SCHEMA` on the selected catalog to the App service principal. The bootstrap installer performs this grant when the installer identity is authorized.
- **Lakebase authentication fails:** confirm both Postgres App resources use `CAN_CONNECT_AND_CREATE` and the endpoint is active.
- **A run fails after App restart:** the App marks interrupted runs failed. Launch a new run; the immutable prior manifest stays in history.
- **CDF stays setup required:** check that CDF is started for `databricks_postgres.lakeload_bench`, every captured table has `REPLICA IDENTITY FULL`, and `<destination>.lb_orders_history` is queryable.
- **Synced table stays setup required:** press Prepare, inspect `synced_tables/lakeload_pg.lakeload_sync.serving_profile`, and confirm the App identity can query `lakeload_sync.serving_profile`.
- **Search stays setup required:** workspace preview access and packages in `pg_available_extensions` are not project activation. Enable Search for `projects/lakeload`, wait for compute restart, then press Prepare.
- **Advanced telemetry stays setup required:** confirm the Observability configuration is assigned to `projects/lakeload`, the export identity has every required permission, compute was restarted, and unprefixed telemetry tables are landing in the selected schema.
- **The first DBSQL query is slow:** record it as cold start. Run a separate warm trial before comparing steady-state latency.
- **The UI remains available but a benchmark is saturated:** control metrics are stored in the production branch while load targets the isolated benchmark branch.

## Cleanup

Cleanup is intentionally separate from installation because deleting the Lakebase project is permanent. Delete the bundle first, inspect the project and catalog contents, then delete resources explicitly:

```bash
databricks bundle destroy -p <profile> -t default
databricks postgres delete-project projects/lakeload -p <profile>
```

Delete the selected catalog or schema only after confirming it contains no customer-owned objects. LakeLoad cleanup needs to remove only its `lakeload_*` tables.
