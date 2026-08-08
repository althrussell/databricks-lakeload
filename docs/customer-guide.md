# LakeLoad customer guide

LakeLoad is a repeatable Databricks App for demonstrating Lakebase OLTP, DBSQL OLAP, and bidirectional LTAP. It creates deterministic operational and Delta datasets, runs measured workloads, and keeps engine guidance beside each result.

## What gets installed

- One Lakebase Autoscaling project with a protected-style `production` control branch and an isolated `benchmark` branch.
- A Databricks App whose service principal owns `lakeload_control` and `lakeload_bench` PostgreSQL schemas.
- One serverless Lakeflow Job runner for distributed Lakebase load.
- One DBSQL warehouse binding for Delta setup and OLAP scenarios.
- One executable DBSQL-versus-Lakebase notebook job.
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

Open the App, select **Setup**, then select **Prepare all data**. The App service principal creates its PostgreSQL schemas and the `main.lakeload` Unity Catalog schema. This operation can take several minutes the first time because it creates five million deterministic Delta fact rows.

### Why installation has a bootstrap command

A Databricks App cannot create and bind the Lakebase project that authenticates the App before the App service principal exists. The installer resolves this dependency in two phases: create Lakebase, deploy the App, then grant the new App service principal scoped catalog rights. After that, every data preparation and test action is initiated in the App.

## Readiness states

The Setup page performs live checks.

| State | Meaning | Operator action |
|---|---|---|
| Ready | The App can use the capability now. | None. |
| Setup required | The workspace supports the feature but an administrator must complete a preview or project-level action. | Follow the detail shown in the row and the feature steps below. |
| Blocked | A required resource cannot be reached. | Correct the binding or permission, then reload. |

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
- Query: one account range joined to the latest 1,000 audit events, grouped by region.
- Interpretation: bounded operational joins belong close to mutable state. Large historical scans do not.

### OLAP: DBSQL

#### Delta point lookup

- Question: What overhead appears when an analytical engine serves one application lookup at a time?
- Query: one ID filter over `main.lakeload.account`.
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
2. Set full row images for every captured benchmark table:

   ```sql
   ALTER TABLE lakeload_bench.account REPLICA IDENTITY FULL;
   ALTER TABLE lakeload_bench.product REPLICA IDENTITY FULL;
   ALTER TABLE lakeload_bench.history REPLICA IDENTITY FULL;
   ALTER TABLE lakeload_bench.orders REPLICA IDENTITY FULL;
   ```

3. In the Lakebase project UI, activate CDF and select the destination catalog/schema.
4. Add `CDF_DELTA_TABLE=<catalog>.<schema>.<table>` to the App environment and redeploy.
5. Reload Setup. CDF is ready only when `wal2delta` is installed, replica identity is full, and the destination is configured.

CDF activation is currently a UI operation. It is not safe for the installer to guess a destination or preview setting.

### Synced tables

Official guide: [Sync tables to Lakebase](https://docs.databricks.com/aws/en/oltp/projects/sync-tables)

1. Create a Delta table with a stable primary key, for example `main.lakeload.customer_profile`.
2. Create a Lakebase synced table targeting the benchmark project and database. Use triggered or continuous scheduling according to the freshness test.
3. Grant the App service principal `USAGE` on the target PostgreSQL schema and `SELECT` on the synced table.
4. Add `SYNC_TABLE_NAME=<postgres-schema>.<table>` to the App environment and redeploy.
5. Do not insert, update, or delete rows in the synced table from Lakebase; the sync service owns it.

LakeLoad keeps this separate from bundle deployment because current bundle/Terraform support does not cover all Lakebase Autoscaling synced-table options.

### Lakebase Search

Official guide: [Lakebase Search](https://docs.databricks.com/aws/en/oltp/projects/lakebase-search)

1. Confirm `lakebase_text` and `lakebase_vector` appear in `pg_available_extensions`.
2. Review the project restart and irreversibility warning with the operator.
3. Enable Search in project settings during a maintenance window.
4. Install the extensions and create the documented indexes in the benchmark branch.
5. Reload Setup, prepare deterministic text/embedding data, then run keyword, vector, and hybrid tests.

Do not enable Search as part of unattended installation. Enabling it restarts compute and cannot be reversed for the project.

### OpenTelemetry

Official guide: [Lakebase OpenTelemetry](https://docs.databricks.com/aws/en/oltp/projects/opentelemetry)

1. Provision an OTLP-compatible collector that the Lakebase project can reach.
2. Configure the project exporter and authentication in Lakebase settings.
3. Set `OTEL_EXPORTER_OTLP_ENDPOINT` for the App and runner if application spans should use the same collector.
4. Redact SQL literals and credentials according to customer policy.
5. Run a short benchmark and confirm the LakeLoad run ID appears in the trace backend before a presentation.

LakeLoad does not provision an external collector.

## Run a fair comparison

1. Prepare data once from Setup.
2. Record the Lakebase endpoint CU minimum/maximum, DBSQL warehouse size, runner location, data scale, seed, and Git commit.
3. Run one warm-up that is excluded from headline metrics.
4. Run at least three measured repetitions in the same cache state.
5. Use the same logical question, not necessarily identical physical SQL. A bounded operational query and a historical analytical query are different workloads.
6. Report median throughput plus p50, p95, p99, errors, and freshness. Do not average p99 values across workers.
7. Label cold-start and scale-to-zero measurements separately.
8. Stop when the error guardrail is crossed. Saturation is a result, not a reason to keep increasing load.

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
POST   /api/lakeload/setup
POST   /api/lakeload/runs
GET    /api/lakeload/runs/{run_id}
DELETE /api/lakeload/runs/{run_id}
POST   /api/lakeload/verify-invariant
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

## Troubleshooting

- **DBSQL readiness is blocked:** confirm the `sql-warehouse` App resource exists and the App service principal has `CAN_USE`. Start the warehouse once before setup.
- **Unity Catalog setup stops:** grant `USE CATALOG` and `CREATE SCHEMA` on the selected catalog to the App service principal. The bootstrap installer performs this grant when the installer identity is authorized.
- **Lakebase authentication fails:** confirm both Postgres App resources use `CAN_CONNECT_AND_CREATE` and the endpoint is active.
- **A run fails after App restart:** the App marks interrupted runs failed. Launch a new run; the immutable prior manifest stays in history.
- **CDF stays setup required:** check preview enablement, `wal2delta`, `REPLICA IDENTITY FULL`, and `CDF_DELTA_TABLE`.
- **Search stays setup required:** packages being available is not the same as Search being enabled and extensions installed.
- **The first DBSQL query is slow:** record it as cold start. Run a separate warm trial before comparing steady-state latency.
- **The UI remains available but a benchmark is saturated:** control metrics are stored in the production branch while load targets the isolated benchmark branch.

## Cleanup

Cleanup is intentionally separate from installation because deleting the Lakebase project is permanent. Delete the bundle first, inspect the project and catalog contents, then delete resources explicitly:

```bash
databricks bundle destroy -p <profile> -t default
databricks postgres delete-project projects/lakeload -p <profile>
```

Delete `main.lakeload` only after confirming it contains no customer-owned tables.
