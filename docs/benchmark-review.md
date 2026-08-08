# LakeLoad benchmark review

## Executive assessment

LakeLoad now meets the core goal: it generates repeatable Lakebase and DBSQL workloads, streams client and PostgreSQL metrics, compares matched OLTP and OLAP questions, demonstrates branches during load, and exports the evidence behind a result.

The customer story is not “Lakebase wins every query.” It is:

1. Lakebase keeps synchronous requests, transactions, and bounded operational joins fast under concurrency.
2. DBSQL moves wide scans, joins, windows, and BI concurrency away from the application database.
3. CDF and synced tables connect the paths into LTAP, while branches make testing and recovery safe.

The UI declares a comparison decision-grade only when both runs share the method version, scale, seed, concurrency, duration, ramp, warm-up, and execution model. Three-pass mode adds a repeatability check before a result is quoted.

## Findings and resolutions

| Area            | Review finding                                                                             | Resolution                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| OLTP parity     | Lakebase used 10K accounts/1K products while DBSQL used 1M/10K, with different SQL shapes. | Both use the same seeded lookup over 1M accounts and 10K products.                                 |
| OLAP parity     | PostgreSQL derived its product join differently from Delta.                                | Both persist `product_id` and run the same five-million-row aggregation.                           |
| Open loop       | DBSQL delayed closed-loop workers rather than maintaining independent arrivals.            | Both engines schedule arrivals, cap in-flight work, and expose offered demand and admission drops. |
| Rate accuracy   | Counts were labeled per-second without recording sample width.                             | Every bucket stores `interval_ms`; rates are normalized.                                           |
| Tail latency    | Coarse buckets distorted OLTP percentiles and failures could distort success latency.      | Headline p50/p95/p99 use exact successful latencies.                                               |
| Warm state      | Warm-up was described but not enforced or excluded.                                        | Warm-up is configurable, shaded, and excluded from headline results.                               |
| Reproducibility | Global random selection produced irreproducible request streams.                           | Every run uses a recorded deterministic per-worker seed.                                           |
| Errors          | Query failures and client saturation were combined.                                        | Query errors and admission drops are separate.                                                     |
| Winner validity | Independent latest runs could be scored despite different settings.                        | The evidence gate blocks a winner until v3 fingerprints match.                                     |
| Confidence      | A single pass could be quoted without variation.                                           | Three-pass mode shows median p95 and full range; ≤15% spread is the stability target.              |
| Portability     | Evidence only existed in the UI.                                                           | Every run exports self-describing JSON and per-sample CSV.                                         |

## Metric contract

- **Completed ops/s:** successful operations divided by actual interval width.
- **Offered ops/s:** scheduled arrivals divided by actual interval width.
- **Admission drops:** arrivals not started because the configured in-flight limit was full.
- **Query errors:** admitted operations that returned an engine error.
- **p50/p95/p99:** client-observed successful request latency, including network and API overhead.
- **Database tx/s:** PostgreSQL commits plus rollbacks normalized by database-stat sample width; contextual endpoint telemetry, not a synonym for workload operations.
- **Headline summary:** measured phase only; warm-up remains visible and is marked `warmup`.

## Fair comparison protocol

1. Confirm 1M accounts, 10K products, and 5M history rows.
2. Use the same concurrency, duration, ramp, warm-up, execution model, and seed.
3. Run engines sequentially to avoid client-capacity interference.
4. Use matched OLTP for request-path placement and matched OLAP for scan placement.
5. Use best-fit mode for architecture, not a speed winner.
6. Run three passes before quoting a result; investigate p95 spread above 15%.
7. Export JSON and CSV and state compute, warehouse, endpoint, cache policy, and method version.

## Feature coverage

| Capability                  | Demonstration                                                                                  | Status                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| OLTP concurrency            | Lookups, transfers, mixed traffic, bounded joins                                               | Runnable                                                                             |
| OLAP comparison             | Lookup anti-pattern, 5M scan/join, wide window                                                 | Runnable                                                                             |
| Real-time telemetry         | Demand, throughput, latency, errors, drops, connections, locks, cache, churn                   | Runnable                                                                             |
| Branch/snapshot/restore     | Live branch creation, inspection switching, snapshot during load, and isolated restore compute | Runnable                                                                             |
| Evidence export             | Manifest/method JSON and metric CSV                                                            | Runnable                                                                             |
| Lakebase CDF                | Commit-to-Delta freshness                                                                      | Gated by schema-level CDF activation and a queryable `lb_orders_history` destination |
| Synced tables               | Delta-to-Lakebase serving freshness                                                            | Runnable; continuous lab sync is online                                              |
| Lakebase Search             | Keyword, vector, and hybrid search                                                             | Gated by irreversible project extension enablement                                   |
| Advanced Postgres telemetry | Query counters, waits, and plan diagnosis                                                      | Gated by a project Observability export to the selected schema                       |
| OpenTelemetry               | Run/trace correlation                                                                          | Gated by an external OTLP collector                                                  |

Preview-gated features remain visible with remediation. LakeLoad does not claim a test ran when its prerequisite is absent.

## Interpretation limits

- A Databricks App is a convenient demo client, not a calibrated distributed load appliance. Use the bundled serverless Job runner for maximum-load claims.
- Client-observed DBSQL latency includes warehouse start, queueing, execution, and API polling. It is not execution-only time.
- PostgreSQL statistics are endpoint-wide; other sessions can contribute.
- Default targets are teaching guardrails, not an industry average or product SLA.
- CDF, synced-table, Search, and OpenTelemetry require workspace/project or external prerequisites.
