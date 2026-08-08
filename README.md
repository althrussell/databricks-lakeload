# LakeLoad

LakeLoad is a real-time workload simulator for Databricks Lakebase Autoscaling. It combines a polished Databricks App control surface with an isolated benchmark branch so customers can explore concurrency, transactional mix, complex operational queries, throughput, and latency.

![LakeLoad architecture](https://img.shields.io/badge/Databricks-Apps%20%2B%20Lakebase-FF3621?style=flat-square)

## What it demonstrates

- closed-loop virtual users from 1 to 150 concurrent sessions in the live App
- a serverless Lakeflow Job runner for larger or unattended experiments
- read-heavy, write-heavy, mixed OLTP, and bounded complex-query workloads
- live operations/second, p50/p95/p99 latency, errors, active users, and workload mix
- deterministic PostgreSQL seed data and persistent run history
- short-lived Lakebase OAuth credentials with automatic pool rotation
- isolation between control telemetry and the database endpoint under test

## Architecture

The Databricks App stores run definitions and one-second metric buckets in the `production` branch of the `lakeload` project. Workload traffic is sent to the independent `benchmark` branch and compute endpoint. The App service principal receives `CAN_CONNECT_AND_CREATE` and `CAN_MANAGE_RUN` through declared resources; no database password is stored.

See [the full solution plan](docs/solution-plan.md).

## Deploy from a clean workspace

Prerequisites: a workspace with Databricks Apps and Lakebase Autoscaling enabled, Databricks CLI 1.0+, and Node.js 22+.

```bash
git clone https://github.com/althrussell/databricks-lakeload.git
cd databricks-lakeload
npm install

# The project creates the production branch, primary endpoint, and database.
databricks postgres create-project lakeload --profile <PROFILE>
databricks postgres create-branch projects/lakeload benchmark --profile <PROFILE>

# Copy the benchmark endpoint's generated host into app.yaml and databricks.yml.
databricks postgres get-endpoint \
  projects/lakeload/branches/benchmark/endpoints/primary \
  --profile <PROFILE> -o json

# Set the target workspace host in databricks.yml, then validate and deploy.
databricks bundle validate --profile <PROFILE>
databricks apps deploy --profile <PROFILE>
```

The default project and branch names already match the commands above. For different names, update the target variables in `databricks.yml`. The benchmark hostname appears in both the Lakeflow task in `databricks.yml` and `TARGET_PGHOST` in `app.yaml`. Optionally resize the benchmark endpoint to the CU range you want to demonstrate; the reference deployment uses 1–4 CU.

The deployment creates the Databricks App and serverless Lakeflow Job, binds both Lakebase branches, installs the application, and starts it. No static database password is required.

Deploy once before local development so the App service principal owns `lakeload_control` and `lakeload_bench`.

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
docs/solution-plan.md   Architecture and delivery plan
databricks.yml          App + Job bundle resources
app.yaml                App runtime configuration
```

## Safety

The target schema is fixed to `lakeload_bench`, the UI caps concurrency at 150 and duration at 10 minutes, and the benchmark pool is capped independently. Use a dedicated branch; do not point this tool at production data.
