# Labs validation results

Validated on 2026-08-08 in the `labs` workspace. These are 10-second functional smoke measurements, not capacity claims.

Conditions:

- Lakebase Autoscaling PostgreSQL 17.10, benchmark primary endpoint, 1–4 CU.
- DBSQL Pro serverless X-Small warehouse, one cluster.
- Lakebase operational data: 10,000 accounts and 1,000 products plus generated transfer history.
- Delta analytical data: 1,000,000 accounts, 10,000 products, and 5,000,000 history rows.
- Seed: `424242`.
- Warm state after setup.

## Executable scenario smoke results

| Scenario | Concurrency | Operations | Approx. ops/s | p50 | p95 | p99 | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| Lakebase indexed point lookup | 10 | 34,300 | 3,430 | 3 ms | 5 ms | 8 ms | 0 |
| Lakebase transactional transfer | 10 | 5,789 | 579 | 21 ms | 34 ms | 34 ms | 0 |
| Lakebase mixed application traffic | 10 | 9,254 | 925 | 5 ms | 34 ms | 55 ms | 0 |
| Lakebase operational join | 5 | 1,819 | 182 | 34 ms | 55 ms | 89 ms | 0 |
| DBSQL Delta point lookup | 2 | 22 | 2.2 | 987 ms | 1,597 ms | 2,584 ms | 0 |
| DBSQL five-million-row scan/join | 1 | 18 | 1.8 | 610 ms | 2,584 ms | 2,584 ms | 0 |
| DBSQL windowed customer ranking | 1 | 14 | 1.4 | 987 ms | 2,584 ms | 2,584 ms | 0 |

The DBSQL tests report queries per second, not rows processed per second. Their purpose is to show that DBSQL completes large analytical work while Lakebase remains available for transactions. The point-lookup pair shows why DBSQL warehouse execution should not be used as an application request path.

## Concurrency and arrival-model checks

| Scenario | Model | Users / target | Operations | Approx. ops/s | p95 | p99 | Errors |
|---|---|---:|---:|---:|---:|---:|---:|
| Lakebase point lookup | Closed | 1 user | 2,598 | 260 | 5 ms | 8 ms | 0 |
| Lakebase point lookup | Closed | 50 users | 56,324 | 5,632 | 21 ms | 34 ms | 0 |
| Lakebase point lookup | Closed | 100 users | 69,275 | 6,928 | 34 ms | 55 ms | 0 |
| Lakebase mixed traffic | Open | 500 target ops/s, 20 in-flight cap | 4,998 | 499.8 | 34 ms | 55 ms | 0 |

The open-loop smoke reached 99.96% of the requested 500 operations per second with no errors. The concurrency sweep shows throughput increasing while tail latency rises, which is the intended saturation-curve teaching point.

## Integrity and deployment checks

- Transaction invariant: `SUM(account.balance) = 124995000.00` after the transfer run.
- Negative account count: `0`.
- Comparison notebook job run `886838542352178`: succeeded.
- Remote Playwright smoke: passed in Chromium.
- Responsive check: no document-level horizontal overflow at 1,440 px or 375 px.
- DM Sans and DM Mono: self-hosted files loaded successfully.

## Preview readiness in labs

| Capability | State | Evidence |
|---|---|---|
| Lakebase CDF | Setup required | `wal2delta` available but not installed; benchmark tables are not all `REPLICA IDENTITY FULL`; no destination is configured. |
| Synced tables | Setup required | No synced table bound to the App. |
| Lakebase Search | Setup required | Search packages are available but Search is not enabled. Enablement restarts compute and is irreversible. |
| OpenTelemetry | Setup required | No external OTLP collector is configured. |

LakeLoad includes complete test definitions and UI guidance for these four capabilities. They were not activated automatically because each requires workspace administration, an external destination, or an irreversible project change.
