# LakeLoad

LakeLoad is a real-time OLTP, OLAP, and LTAP benchmark suite for Databricks Lakebase Autoscaling and DBSQL. A Databricks App prepares deterministic data, runs measured scenarios, shows one-second results, and explains which engine fits each workload.

![LakeLoad architecture](https://img.shields.io/badge/Databricks-Apps%20%2B%20Lakebase-FF3621?style=flat-square)

## What it demonstrates

- closed-loop virtual users and open-loop target-rate tests
- a serverless Lakeflow Job runner for larger or unattended experiments
- Lakebase point reads, transactions, mixed traffic, and bounded operational joins
- DBSQL point lookup, large scan/join, and analytical window scenarios
- readiness and test definitions for CDF, synced tables, Search, OpenTelemetry, and a full closed-loop LTAP flow
- one-second live charts for workload/database TPS, p50/p95/p99 latency, connections, row churn, workload mix, cache hit rate, and lock waits
- a persisted Settings selector for choosing and connection-testing the SQL warehouse used by every DBSQL workload
- Settings choices to use an existing Unity Catalog schema, create a schema in an approved catalog, or create both catalog and schema
- a guarded Hard Reset that purges only LakeLoad benchmark data, history, telemetry, snapshots, and restores
- copy-on-write snapshots during active load and non-destructive restore into isolated branches with their own compute
- deterministic PostgreSQL seed data and persistent run history
- decision-grade comparison fingerprints, warm-up exclusion, repeatability checks, and JSON/CSV evidence exports
- offered-rate and admission-drop telemetry so saturation is visible instead of hidden
- short-lived Lakebase OAuth credentials with automatic pool rotation
- isolation between control telemetry and the database endpoint under test

## Architecture

The Databricks App stores run definitions and approximately one-second metric buckets in the `production` branch of the `lakeload` project. Every bucket records its actual width so rates remain accurate. Workload traffic is sent to the independent `benchmark` branch and compute endpoint. Snapshot and restore branches are copy-on-write and never replace the active benchmark branch. The App service principal receives scoped connect/run access through declared resources plus project `CAN_MANAGE` from the installer; no database password is stored.

See the [customer replication guide](docs/customer-guide.md), [benchmark review](docs/benchmark-review.md), [feature evaluation](docs/feature-evaluation.md), [validated labs results](docs/lab-results.md), and [full solution plan](docs/solution-plan.md).

## Deploy from a clean workspace

Prerequisites: a workspace with Databricks Apps and Lakebase Autoscaling enabled, Databricks CLI 0.218+, Python 3.10+, Node.js 22+, and a SQL warehouse.

```bash
git clone https://github.com/althrussell/databricks-lakeload.git
cd databricks-lakeload
npm ci
python scripts/bootstrap.py \
  --profile <PROFILE> \
  --warehouse <WAREHOUSE_ID> \
  --catalog main
```

The installer creates or reuses Lakebase, deploys the App and jobs, binds the SQL warehouse, and grants the App service principal scoped catalog rights. Open the printed App URL, choose the benchmark destination in **Settings**, then select **Prepare benchmark data**. No static database password is required.

For local development, copy `.env.example` to `.env`, fill in the two endpoints and your Databricks login as `PGUSER`, then run `npm run dev`. The file is git-ignored.

## Validate

```bash
npm run typecheck
npm run lint
npm run lint:ast-grep
npx vitest run
npm run test:smoke
databricks bundle validate --profile <PROFILE>
```

## Repository structure

```text
client/                 React/AppKit operations console
server/                 Express routes and live load engine
runner/lakeload_job.py  Portable Lakeflow Job worker
notebooks/              Executable DBSQL-versus-Lakebase comparison
scripts/bootstrap.py    Idempotent customer installer
docs/customer-guide.md  Deployment, scenarios, previews, and interpretation
docs/solution-plan.md   Architecture and delivery plan
databricks.yml          App + Job bundle resources
app.yaml                App runtime configuration
```

## Safety

The target schema is fixed to `lakeload_bench`, the UI caps concurrency at 150 and duration at 10 minutes, and the benchmark pool is capped independently. Use a dedicated branch; do not point this tool at production data.
