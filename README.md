# LakeLoad

LakeLoad is a real-time OLTP, OLAP, and LTAP benchmark suite for Databricks Lakebase Autoscaling and DBSQL. The Databricks App prepares deterministic data, runs measured scenarios, shows one-second evidence, and explains which engine fits each workload.

![Databricks Apps and Lakebase](https://img.shields.io/badge/Databricks-Apps%20%2B%20Lakebase-FF3621?style=flat-square)

![LakeLoad workload control](docs/images/01-workload-control.png)

## Start here

- [Quickstart](docs/quickstart.md) — install, prepare data, run the first workload, compare engines, and branch under load.
- [Full user guide](docs/user-guide.md) — screenshot-led instructions for every App feature.
- [Customer replication guide](docs/customer-guide.md) — permissions, preview configuration, benchmark methodology, APIs, and notebook execution.
- [Validated labs results](docs/lab-results.md) — functional acceptance and observed lab evidence.

## Quickstart

Prerequisites: Databricks Apps and Lakebase Autoscaling, an authenticated CLI profile, a SQL warehouse, Node.js 22+, Python 3.10+, and permission to use or create the selected Unity Catalog schema.

```bash
git clone https://github.com/althrussell/databricks-lakeload.git
cd databricks-lakeload
npm ci
python scripts/bootstrap.py \
  --profile <PROFILE> \
  --warehouse <WAREHOUSE_ID> \
  --catalog <CATALOG>
```

Then open the printed App URL:

1. Select **Settings**.
2. Choose whether to use an existing schema, create a schema in an approved catalog, or create both catalog and schema.
3. Select **Validate and save destination**.
4. Choose **SQL warehouse under test** and select **Use for DBSQL tests**.
5. Select **Prepare benchmark data**.
6. Return to **Live telemetry**, choose a scenario, and select **Simulate load**.

No static database password is stored. The App and jobs use short-lived OAuth database credentials.

## The customer story

| Demonstration     | What the customer sees                                                                                                 | Why it matters                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Lakebase OLTP     | High-concurrency point reads, transactions, mixed traffic, bounded joins, and live PostgreSQL telemetry.               | Lakebase serves mutable application state with low request latency and transactional semantics. |
| DBSQL OLAP        | Five-million-row scans, joins, aggregations, and analytical windows on Delta.                                          | DBSQL applies analytical execution without consuming operational endpoint capacity.             |
| Side-by-side      | Matched protocol fingerprints, workload-specific guardrails, a winner, and both recorded timelines.                    | The App explains engine fit instead of presenting unqualified benchmark numbers.                |
| Branch under load | Copy-on-write branch creation, branch-view switching, snapshots, isolated restores, and uninterrupted workload graphs. | Teams can test, recover, and iterate without replacing the active benchmark branch.             |
| LTAP              | Lakebase CDF, DBSQL enrichment, synced-table return, and boundary freshness.                                           | Operational and analytical systems form one measurable closed loop.                             |

## Live one-second telemetry

Every graph uses the same approximately one-second stream and records its actual sample width. Hover or use Left/Right Arrow to inspect exact values and change from the previous sample.

![LakeLoad live telemetry](docs/images/02-live-telemetry.png)

The console includes workload/database TPS, offered demand, p50/p95/p99 latency, connections, row churn, operation mix, cache hit, lock waits, admission drops, query errors, and LTAP boundary timing.

## Lakebase and DBSQL side by side

LakeLoad runs controlled workload pairs sequentially so the engines do not compete for client capacity. A pair is decision-grade only when method, scale, seed, pressure, warm-up, and successful completion match.

![Lakebase wins the indexed request-serving comparison](docs/images/07-comparison-winner.png)

Use **Indexed request serving** to explain Lakebase OLTP fit, **Five-million-row scan and join** to explain DBSQL OLAP fit, and **Transactions beside analytics** to explain the combined LTAP architecture.

## Branching while load continues

Start a workload and select **Open Branch Lab** beside **Stop load**. Create a live `demo-*` branch, switch the displayed branch, capture a snapshot, or restore an isolated branch while TPS and latency continue updating.

![Branch Lab during active load](docs/images/03-branch-lab.png)

Existing PostgreSQL sessions remain on `benchmark`; **Switch branch view** changes inspection state and never pretends to migrate open connections.

## What it demonstrates

- closed-loop virtual users and open-loop target-rate tests;
- a serverless Lakeflow Job runner for larger or unattended experiments;
- Lakebase point reads, transactions, mixed traffic, and bounded operational joins;
- DBSQL point lookup, large scan/join, and analytical window scenarios;
- one-second live metrics with pointer and keyboard inspection;
- offered-rate and admission-drop telemetry that makes saturation visible;
- persisted run manifests, warm-up exclusion, repeatability checks, and JSON/CSV exports;
- SQL warehouse selection and connection testing in Settings;
- existing-schema, create-schema, and create-catalog destination paths;
- live readiness for CDF, synced tables, Search, advanced telemetry, and OpenTelemetry;
- a complete Lakebase-to-Delta-to-DBSQL-to-Lakebase LTAP scenario;
- guarded Hard Reset limited to LakeLoad-owned data and disposable branches;
- short-lived Lakebase OAuth credentials with automatic pool rotation;
- isolation between control telemetry and the database endpoint under test.

## Architecture

The App stores run definitions and one-second metric buckets in the `production` branch of the `lakeload` project. Workload traffic is sent to the independent `benchmark` branch and compute endpoint. Demo, snapshot, and restore branches are copy-on-write children and never replace the active workload branch.

The App service principal receives scoped connect/run access through declared resources plus project `CAN_MANAGE` from the installer. DBSQL reads the selected Unity Catalog tables through the configured warehouse. The Lakeflow Job and comparison notebook use the same scenario definitions and evidence model.

```text
Databricks App
├── production branch      control state, runs, metrics, settings
├── benchmark branch       Lakebase workload data and telemetry
│   ├── demo-*             live copy-on-write branches
│   ├── snapshot-*         point-in-time snapshots
│   └── restore-*          isolated restore branches + compute
├── SQL warehouse          Delta preparation and DBSQL workloads
├── Unity Catalog          matching Delta data and LTAP tables
└── Lakeflow Job/notebook  distributed runs and executable comparison
```

## Capability readiness

Settings distinguishes feature access from actual configuration. A preview toggle is not reported as ready until LakeLoad can exercise the required resource, extension, permission, and data path.

![LakeLoad capability readiness](docs/images/13-capability-readiness.png)

Administrator-controlled or irreversible actions—such as enabling Lakebase Search or supplying an OTLP collector—remain explicit.

## Deploy from a clean workspace

The bootstrap command is idempotent. It creates or reuses Lakebase, deploys the App and jobs, binds the SQL warehouse, and grants the App service principal scoped catalog rights.

```bash
python scripts/bootstrap.py \
  --profile <PROFILE> \
  --warehouse <WAREHOUSE_ID> \
  --catalog <CATALOG>
```

For local development, copy `.env.example` to `.env`, fill in the two endpoints and your Databricks login as `PGUSER`, then run `npm run dev`. The file is git-ignored.

## Documentation

- [Quickstart](docs/quickstart.md)
- [User guide](docs/user-guide.md)
- [Customer replication guide](docs/customer-guide.md)
- [Feature evaluation](docs/feature-evaluation.md)
- [Benchmark specialist review](docs/benchmark-review.md)
- [Labs acceptance results](docs/lab-results.md)
- [Solution plan](docs/solution-plan.md)

## Regenerate documentation screenshots

The screenshot set is generated by Playwright against a deployed App. The workflow starts and stops a live workload, creates and removes a disposable demo branch, runs one matched comparison, and never performs Hard Reset.

```bash
DATABRICKS_APP_TOKEN=<OAUTH_TOKEN> \
PLAYWRIGHT_BASE_URL=https://<app-url> \
UPDATE_DOC_SCREENSHOTS=1 \
npm run docs:screenshots
```

Screenshots are written to `docs/images/`. Review the generated images and lab-specific values before committing them.

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
client/                         React/AppKit operations console
server/                         Express routes and live load engine
runner/lakeload_job.py          Portable Lakeflow Job worker
notebooks/                      Executable DBSQL-versus-Lakebase comparison
scripts/bootstrap.py            Idempotent customer installer
tests/docs-screenshots.spec.ts  Repeatable documentation capture
docs/quickstart.md              First deployment and demo
docs/user-guide.md              Screenshot-led operator guide
docs/customer-guide.md          Deployment and replication reference
docs/images/                    Versioned App screenshots
databricks.yml                  App + Job bundle resources
app.yaml                        App runtime configuration
```

## Safety

The UI caps concurrency at 150 and duration at 10 minutes, and the benchmark pool is capped independently. Use the dedicated `benchmark` branch; do not point LakeLoad at production data. Hard Reset requires the exact phrase `RESET LAKELOAD` and deletes only recognized LakeLoad artifacts.
