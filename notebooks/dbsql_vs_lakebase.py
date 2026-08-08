# Databricks notebook source
# MAGIC %md
# MAGIC # DBSQL and Lakebase: use each engine for its intended workload
# MAGIC
# MAGIC This notebook runs two paired comparisons over deterministic LakeLoad data:
# MAGIC
# MAGIC 1. One indexed account lookup, repeated against Lakebase and a Delta table through DBSQL.
# MAGIC 2. One large aggregation against Delta through DBSQL, with the bounded operational equivalent in Lakebase.
# MAGIC
# MAGIC The goal is not to declare one engine universally faster. It shows why applications use Lakebase for concurrent OLTP and DBSQL for OLAP. Record the warehouse size, Lakebase CU range, cache state, concurrency, and data scale with every result.

# COMMAND ----------

# MAGIC %pip install 'databricks-sdk>=0.81.0' 'psycopg[binary]>=3.1' --quiet

# COMMAND ----------

dbutils.widgets.text("warehouse_id", "", "DBSQL warehouse ID")
dbutils.widgets.text("lakebase_endpoint", "projects/lakeload/branches/benchmark/endpoints/primary", "Lakebase endpoint")
dbutils.widgets.text("lakebase_host", "", "Lakebase host")
dbutils.widgets.text("iterations", "20", "Iterations")
dbutils.widgets.dropdown("cache_state", "warm", ["warm", "cold"], "Recorded cache state")

# COMMAND ----------

from __future__ import annotations

import statistics
import time
from dataclasses import dataclass

import psycopg
from databricks.sdk import WorkspaceClient
from databricks.sdk.service.sql import Disposition, Format

w = WorkspaceClient()
WAREHOUSE_ID = dbutils.widgets.get("warehouse_id")
ENDPOINT = dbutils.widgets.get("lakebase_endpoint")
HOST = dbutils.widgets.get("lakebase_host")
ITERATIONS = int(dbutils.widgets.get("iterations"))
CACHE_STATE = dbutils.widgets.get("cache_state")

if not WAREHOUSE_ID:
    raise ValueError("Set warehouse_id before running the notebook")
if not HOST:
    endpoint = w.postgres.get_endpoint(ENDPOINT)
    HOST = endpoint.status.hosts.host

identity = w.current_user.me().user_name
credential = w.postgres.generate_database_credential(endpoint=ENDPOINT)


@dataclass
class Result:
    engine: str
    workload: str
    values_ms: list[float]

    def row(self) -> tuple:
        ordered = sorted(self.values_ms)
        percentile = lambda q: ordered[min(len(ordered) - 1, int((len(ordered) - 1) * q))]
        return (
            self.engine,
            self.workload,
            len(ordered),
            round(statistics.fmean(ordered), 2),
            round(percentile(0.50), 2),
            round(percentile(0.95), 2),
            round(percentile(0.99), 2),
            CACHE_STATE,
        )


def dbsql(statement: str) -> None:
    response = w.statement_execution.execute_statement(
        warehouse_id=WAREHOUSE_ID,
        statement=statement,
        wait_timeout="50s",
        disposition=Disposition.INLINE,
        format=Format.JSON_ARRAY,
    )
    if response.status and response.status.state.value not in {"SUCCEEDED", "CLOSED"}:
        raise RuntimeError(f"DBSQL statement ended in {response.status.state}: {response.status.error}")


def measure(function, iterations: int = ITERATIONS) -> list[float]:
    output = []
    for _ in range(iterations):
        started = time.perf_counter()
        function()
        output.append((time.perf_counter() - started) * 1000)
    return output


connection = psycopg.connect(
    host=HOST,
    dbname="databricks_postgres",
    user=identity,
    password=credential.token,
    sslmode="require",
    autocommit=True,
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Pair 1: application lookup
# MAGIC
# MAGIC Lakebase uses a PostgreSQL primary-key index and a persistent session. DBSQL filters the equivalent one-million-row Delta table. This comparison demonstrates serving overhead; it is not an OLAP benchmark.

# COMMAND ----------

account_id = 424242


def lakebase_lookup() -> None:
    with connection.cursor() as cursor:
        cursor.execute("SELECT id, region, balance FROM lakeload_bench.account WHERE id = %s", (account_id % 10_000 + 1,))
        cursor.fetchone()


def dbsql_lookup() -> None:
    dbsql(f"SELECT id, region, balance FROM main.lakeload.account WHERE id = {account_id}")


lakebase_lookup()
dbsql_lookup()
lookup_results = [
    Result("Lakebase", "Indexed point lookup", measure(lakebase_lookup)),
    Result("DBSQL", "Delta point lookup", measure(dbsql_lookup)),
]
display(spark.createDataFrame([result.row() for result in lookup_results], "engine string, workload string, iterations int, mean_ms double, p50_ms double, p95_ms double, p99_ms double, cache_state string"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Pair 2: analytical aggregation
# MAGIC
# MAGIC DBSQL scans five million Delta rows, joins the product dimension, and aggregates by region and category. The Lakebase query is deliberately bounded to the most recent 1,000 operational events. Running the unbounded analytical scan on the OLTP endpoint would compete with application transactions.

# COMMAND ----------

dbsql_olap = """
SELECT h.region, p.category, COUNT(*) AS events, SUM(ABS(h.amount)) AS gross_amount,
       APPROX_COUNT_DISTINCT(h.account_id) AS active_accounts
FROM main.lakeload.history h
JOIN main.lakeload.product p ON p.id = pmod(h.product_id, 10000) + 1
GROUP BY h.region, p.category ORDER BY gross_amount DESC
"""


def run_dbsql_olap() -> None:
    dbsql(dbsql_olap)


def run_lakebase_bounded() -> None:
    with connection.cursor() as cursor:
        cursor.execute("""
            SELECT a.region, COUNT(h.id), COALESCE(AVG(ABS(h.amount)), 0)
            FROM lakeload_bench.account a
            LEFT JOIN (
              SELECT id, account_id, amount FROM lakeload_bench.history
              ORDER BY created_at DESC LIMIT 1000
            ) h ON h.account_id = a.id
            WHERE a.id BETWEEN 1 AND 1000
            GROUP BY a.region ORDER BY COUNT(h.id) DESC
        """)
        cursor.fetchall()


run_dbsql_olap()
run_lakebase_bounded()
analysis_results = [
    Result("DBSQL", "Five-million-row scan and join", measure(run_dbsql_olap, max(3, ITERATIONS // 4))),
    Result("Lakebase", "Bounded operational aggregate", measure(run_lakebase_bounded)),
]
display(spark.createDataFrame([result.row() for result in analysis_results], "engine string, workload string, iterations int, mean_ms double, p50_ms double, p95_ms double, p99_ms double, cache_state string"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Interpret the result
# MAGIC
# MAGIC - Use **Lakebase** for indexed request/response access, concurrent writes, PostgreSQL transactions, constraints, and operational joins bounded around the current entity.
# MAGIC - Use **DBSQL** for large scans, wide joins, window functions, BI concurrency, and aggregations across historical data.
# MAGIC - Use **LTAP** to connect the paths: Lakebase CDF carries committed changes into Delta; DBSQL enriches them; synced tables return curated data to Lakebase for serving.
# MAGIC - Do not compare only elapsed time. Record p50/p95/p99, throughput, error rate, concurrency, queue/compile/execution time, data size, cache state, CU range, and warehouse size.

# COMMAND ----------

connection.close()
