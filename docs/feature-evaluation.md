# Lakebase feature evaluation for LakeLoad

| Feature | Add to LakeLoad | Tests | Value demonstrated | Constraint |
|---|---|---|---|---|
| Synced tables | Yes | Delta-to-Lakebase freshness, serving latency, primary-key behavior, schema/type mapping, pipeline recovery | Curated lakehouse data returned to an operational application path | System-owned/read-mostly; App needs explicit `USAGE` and `SELECT`; some Autoscaling options require API/CLI rather than bundle Terraform |
| Lakebase CDF | Yes | Insert/update/delete semantics, commit-to-Delta lag, ordering, duplicates, retry/idempotency, burst throughput | Incremental operational changes reach governed Delta without batch extraction | Workspace preview and UI activation; captured tables require `REPLICA IDENTITY FULL` |
| OpenTelemetry | Yes | Trace/run correlation, high-p99 diagnosis, error attribution, collector interruption | Explains why latency or throughput changed without replacing benchmark histograms | Requires an external OTLP backend and project-level configuration |
| Lakebase Search | Yes | Keyword, vector, hybrid RRF, filtered retrieval, concurrent latency, relevance checks | Search beside mutable PostgreSQL state without a separate serving database | Enablement restarts compute and is irreversible for the project |

The combined LTAP scenario is the strongest demonstration: Lakebase commits an order, CDF sends it to Delta, DBSQL enriches it, a synced table returns the result, and Lakebase serves it during checkout. Each boundary has its own freshness metric so the demo remains technically honest.

DBSQL and Lakebase should not run identical unbounded work as a winner-takes-all comparison. LakeLoad pairs logical business questions and shows the correct physical workload for each engine: transactions and indexed request serving in Lakebase; scans, joins, windows, and BI in DBSQL.
