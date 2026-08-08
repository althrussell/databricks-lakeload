# LakeLoad

LakeLoad is a real-time OLTP, OLAP, and LTAP benchmark suite for Databricks Lakebase Autoscaling and DBSQL. A Databricks App prepares deterministic data, runs measured scenarios, shows one-second results, and explains which engine fits each workload.

![LakeLoad architecture](https://img.shields.io/badge/Databricks-Apps%20%2B%20Lakebase-FF3621?style=flat-square)

## What it demonstrates

- closed-loop virtual users and open-loop target-rate tests
- a serverless Lakeflow Job runner for larger or unattended experiments
- Lakebase point reads, transactions, mixed traffic, and bounded operational joins
- DBSQL point lookup, large scan/join, and analytical window scenarios
- readiness and test definitions for CDF, synced tables, Search, OpenTelemetry, and a full closed-loop LTAP flow
- live operations/second, p50/p95/p99 latency, errors, active users, and workload mix
- deterministic PostgreSQL seed data and persistent run history
- short-lived Lakebase OAuth credentials with automatic pool rotation
- isolation between control telemetry and the database endpoint under test

## Architecture

The Databricks App stores run definitions and one-second metric buckets in the `production` branch of the `lakeload` project. Workload traffic is sent to the independent `benchmark` branch and compute endpoint. The App service principal receives `CAN_CONNECT_AND_CREATE` and `CAN_MANAGE_RUN` through declared resources; no database password is stored.

See the [customer replication guide](docs/customer-guide.md), [feature evaluation](docs/feature-evaluation.md), [validated labs results](docs/lab-results.md), and [full solution plan](docs/solution-plan.md).

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

The installer creates or reuses Lakebase, deploys the App and jobs, binds the SQL warehouse, and grants the App service principal scoped catalog rights. Open the printed App URL and select **Setup > Prepare all data**. No static database password is required.

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
