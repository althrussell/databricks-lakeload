# Labs validation results

Validated on 2026-08-08 in the `labs` workspace. These are 10-second functional smoke measurements, not capacity claims.

Conditions:

- Lakebase Autoscaling PostgreSQL 17.10, benchmark primary endpoint, 1–4 CU.
- DBSQL Pro serverless X-Small warehouse, one cluster.
- Lakebase data: 1,000,000 accounts, 10,000 products, and 5,000,000 deterministic history rows.
- Delta analytical data: 1,000,000 accounts, 10,000 products, and 5,000,000 history rows.
- Seed: `424242`.
- Warm state after setup.

## Methodology v3 acceptance results

These runs use exact successful-request percentiles, a deterministic seed, three seconds of excluded pre-measure traffic, matched 1M/10K/5M cardinalities, and actual-width rate buckets.

| Workload                               | Engine   |            Clients / model | Measured operations | Approx. ops/s |          p50 |          p95 |          p99 |                 Errors |
| -------------------------------------- | -------- | -------------------------: | ------------------: | ------------: | -----------: | -----------: | -----------: | ---------------------: |
| Matched indexed account/product lookup | Lakebase |                  10 closed |              37,248 |       3,724.8 |      2.34 ms |      4.77 ms |      7.49 ms |                      0 |
| Matched indexed account/product lookup | DBSQL    |                  10 closed |                 123 |          12.3 |    703.92 ms |  1,678.61 ms |  1,835.67 ms |                      0 |
| Matched 5M scan and two-dimension join | Lakebase |                   1 closed |                   1 |           0.1 | 17,551.52 ms | 17,551.52 ms | 17,551.52 ms |                      0 |
| Matched 5M scan and two-dimension join | DBSQL    |                   1 closed |                  22 |           2.2 |    465.84 ms |    517.83 ms |    600.40 ms |                      0 |
| Mixed OLTP traffic                     | Lakebase |                  24 closed |              22,416 |       2,241.6 |      4.19 ms |     31.68 ms |     41.67 ms |                      0 |
| Indexed lookup saturation              | Lakebase | 3,000 target / 5 in-flight |              11,810 |       1,181.0 |      3.68 ms |      4.99 ms |      7.68 ms | 18,188 admission drops |

The saturation run is intentionally overloaded: completed throughput averaged about 1,181 ops/s while offered demand remained near 3,000 ops/s. All failures were load-generator admission drops and no admitted database query failed. This is the behavior the new bottleneck panel is designed to explain.

The remaining tables below are retained as methodology-v1 historical validation. Their Fibonacci bucket percentiles and asymmetric point-lookup scale must not be compared directly with v3 results.

## Historical methodology-v1 scenario smoke results

| Scenario                           | Concurrency | Operations | Approx. ops/s |    p50 |      p95 |      p99 | Errors |
| ---------------------------------- | ----------: | ---------: | ------------: | -----: | -------: | -------: | -----: |
| Lakebase indexed point lookup      |          10 |     34,300 |         3,430 |   3 ms |     5 ms |     8 ms |      0 |
| Lakebase transactional transfer    |          10 |      5,789 |           579 |  21 ms |    34 ms |    34 ms |      0 |
| Lakebase mixed application traffic |          10 |      9,254 |           925 |   5 ms |    34 ms |    55 ms |      0 |
| Lakebase operational join          |           5 |      1,819 |           182 |  34 ms |    55 ms |    89 ms |      0 |
| DBSQL Delta point lookup           |           2 |         22 |           2.2 | 987 ms | 1,597 ms | 2,584 ms |      0 |
| DBSQL five-million-row scan/join   |           1 |         18 |           1.8 | 610 ms | 2,584 ms | 2,584 ms |      0 |
| DBSQL windowed customer ranking    |           1 |         14 |           1.4 | 987 ms | 2,584 ms | 2,584 ms |      0 |

The DBSQL tests report queries per second, not rows processed per second. Their purpose is to show that DBSQL completes large analytical work while Lakebase remains available for transactions. The point-lookup pair shows why DBSQL warehouse execution should not be used as an application request path.

## Historical methodology-v1 side-by-side comparison results

These paired runs used the **Compare engines** UI with shared controls and sequential execution. Each row is one 10-second functional run per engine in warm state.

| Matched workload                               | Engine   | Clients | Operations | Approx. ops/s |         p50 |         p95 |         p99 | Errors |
| ---------------------------------------------- | -------- | ------: | ---------: | ------------: | ----------: | ----------: | ----------: | -----: |
| Indexed lookup, key range 1–10,000             | Lakebase |      10 |     20,613 |       2,061.3 |        5 ms |        8 ms |       13 ms |      0 |
| Indexed lookup, key range 1–10,000             | DBSQL    |      10 |         50 |           5.0 |    1,597 ms |    4,181 ms |    6,765 ms |      0 |
| Five-million-row scan with two dimension joins | Lakebase |       1 |          1 |           0.1 | 30,000 ms\* | 30,000 ms\* | 30,000 ms\* |      0 |
| Five-million-row scan with two dimension joins | DBSQL    |       1 |         17 |           1.7 |      610 ms |    2,584 ms |    2,584 ms |      0 |

The matched point lookup demonstrates Lakebase's OLTP fit under concurrent request pressure. The matched scan demonstrates DBSQL's OLAP fit: it completed repeated five-million-row analytical queries while the PostgreSQL lane completed one. `*` LakeLoad's current histogram ceiling is 30 seconds, so the Lakebase scan values are capped rather than exact beyond that boundary. These are environment-specific observations, not universal performance claims.

## Concurrency and arrival-model checks

| Scenario               | Model  |                     Users / target | Operations | Approx. ops/s |   p95 |   p99 | Errors |
| ---------------------- | ------ | ---------------------------------: | ---------: | ------------: | ----: | ----: | -----: |
| Lakebase point lookup  | Closed |                             1 user |      2,598 |           260 |  5 ms |  8 ms |      0 |
| Lakebase point lookup  | Closed |                           50 users |     56,324 |         5,632 | 21 ms | 34 ms |      0 |
| Lakebase point lookup  | Closed |                          100 users |     69,275 |         6,928 | 34 ms | 55 ms |      0 |
| Lakebase mixed traffic | Open   | 500 target ops/s, 20 in-flight cap |      4,998 |         499.8 | 34 ms | 55 ms |      0 |

The open-loop smoke reached 99.96% of the requested 500 operations per second with no errors. The concurrency sweep shows throughput increasing while tail latency rises, which is the intended saturation-curve teaching point.

## Integrity and deployment checks

- Historical v1 transaction invariant: `SUM(account.balance) = 124995000.00` after the 10K-account transfer run. V2 stores its 1M-account baseline in `dataset_marker.expected_balance` and verifies against that recorded value.
- Negative account count: `0`.
- Comparison notebook job run `229094537513833`: succeeded with the matched v3 1M/10K lookup and 5M scan definitions.
- Remote Playwright smoke: passed in Chromium.
- Full hosted acceptance on the deployed App: 13 of 14 tests passed on the first exhaustive run; the remaining case exposed a 16 px readiness-badge overflow at 375 px. After the responsive-grid fix was deployed, all three targeted 375 px regression checks passed.
- Guarded Hard Reset acceptance: completed in approximately four seconds, removed 29 stored runs and their metrics, emptied all Lakebase benchmark tables, and purged two `snapshot-*`/`restore-*` branches. It preserved `production`, `benchmark`, the App deployment, and the selected `cost-wh` warehouse. Reset removes only the four LakeLoad Delta tables from the selected Unity Catalog schema, preserving every other object. A subsequent **Prepare benchmark data** restored the deterministic 5,000,000-row lab dataset. Current reset scope also includes disposable `demo-*` branches.
- Side-by-side OLTP and OLAP acceptance: both engine lanes completed, result scorecards populated, and all comparison charts exposed pointer inspection.
- Warehouse Settings acceptance: the App listed both accessible `labs` warehouses, switched from `cost-wh` to `Serverless Starter Warehouse`, connection-tested it, completed a DBSQL point-lookup run with the selected warehouse stamped in the run manifest, and restored the baseline selection.
- Responsive check: no document-level horizontal overflow at 1,440 px or 375 px.
- DM Sans and DM Mono: self-hosted files loaded successfully.

## Real-time telemetry and branch acceptance

Validated against deployment `lakeload` on 2026-08-08:

- A 24-user mixed workload produced a new `run_metric` row on every observed one-second interval; the acceptance harness saw the series advance from sample 1 to sample 117 without regression.
- Observed workload throughput during the run was approximately 560–1,100 operations/second. PostgreSQL telemetry simultaneously reported 25–32 total connections, 99.98–99.99% cache hit, database size, transaction deltas, row churn, and lock state.
- All seven Live Console SVG charts changed after successive samples: throughput/demand, latency, connections, row churn, operation mix, database health, and saturation signals.
- Both Branch Lab charts changed after successive samples while the branch operation stream and topology were also polling every second.
- On 2026-08-09, the hosted Branch Lab acceptance started load, opened Branch Lab from the running-workload action, created a `demo-*` branch from `benchmark`, provisioned dedicated read-write compute, selected the new branch automatically, and switched the branch view while the active workload remained on `benchmark`. Cleanup removed the disposable branch and left `production` and `benchmark` intact.
- Copy-on-write snapshot `snapshot-live-0808055022` reached `READY` while load remained active.
- Restore `restore-live-0808055022` reached `READY` from that snapshot with its dedicated `primary` read-write compute `ACTIVE`.
- The benchmark workload continued to sample throughout branch creation. Restore never reset or replaced `benchmark`.
- Deployed Chromium smoke, live-chart advancement, and 375 px overflow tests passed.

These are functional acceptance observations, not benchmark claims. Snapshot and restore control-plane duration varies by environment and should be shown beside the uninterrupted workload telemetry rather than presented as a fixed SLA.

## Preview readiness in labs

All five workspace preview toggles were confirmed **On** on 2026-08-08. Readiness below comes from the deployed App's live project, PostgreSQL, and Delta probes; a workspace toggle alone is not treated as proof that a feature is configured.

| Capability                  | State                        | Evidence                                                                                                                                                                                                                                                                                  |
| --------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lakebase CDF                | Project action required      | `REPLICA IDENTITY FULL` is configured for the benchmark tables. CDF still must be started on branch `benchmark` for `databricks_postgres.lakeload_bench` into `main.lakeload`; `main.lakeload.lb_orders_history` is not yet queryable.                                                    |
| Synced tables               | Ready and tested             | Continuous resource `synced_tables/lakeload_pg.lakeload_sync.serving_profile` is online and queryable as `lakeload_sync.serving_profile`. Run `144effeb-376e-4a67-b3bd-61d99f770c2a` completed two cycles with zero errors: 8.07 s and 8.21 s Delta-to-Lakebase freshness (p95 8.2146 s). |
| Lakebase Search             | Project action required      | Packages are available, but extension creation returns `lakebase_vector must be loaded via shared_preload_libraries`. Enable Search once in `projects/lakeload` settings; this irreversibly enables the project feature and restarts every project compute.                               |
| Local query statistics      | Ready                        | `pg_stat_statements` is installed and available to LakeLoad immediately.                                                                                                                                                                                                                  |
| Advanced Postgres telemetry | Configuration required       | No Observability export is assigned to `projects/lakeload`; `pg_stat_statements_counters`, `active_session_history`, and `plan_history` are not yet queryable in `main.lakeload`.                                                                                                         |
| OpenTelemetry               | External dependency required | The workspace preview is enabled, but no reachable external OTLP endpoint and credentials are configured. LakeLoad does not fabricate or provision this customer-owned destination.                                                                                                       |

Keyword, vector, hybrid RRF, CDF semantics, closed-loop LTAP, advanced diagnosis, and OTLP-correlation scenarios remain visible but cannot be launched until their live prerequisites pass. This prevents a preview toggle from being misrepresented as a successful feature test.

After the exhaustive Hard Reset acceptance deleted and recreated the sync resource, run `37a3361f-11d1-48a8-8299-6e0b4fd122f2` completed a fresh end-to-end cycle in 12.53 s with zero errors. This validates recovery as well as steady-state freshness; neither observation is a product SLA.
