"""Portable LakeLoad worker used by the Lakeflow Job runner."""

from __future__ import annotations

import argparse
import json
import random
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import psycopg
from databricks.sdk import WorkspaceClient


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate repeatable load against Lakebase")
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--database", default="databricks_postgres")
    parser.add_argument(
        "--scenario",
        choices=["lakebase-point-lookup", "lakebase-transfer", "lakebase-mixed", "lakebase-operational-join"],
        default="lakebase-mixed",
    )
    parser.add_argument("--concurrency", type=int, default=50)
    parser.add_argument("--duration", type=int, default=60)
    parser.add_argument("--seed", type=int, default=424242)
    return parser.parse_args()


class Metrics:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.operations = 0
        self.errors = 0
        self.latencies_ms: list[float] = []

    def record(self, latency_ms: float, success: bool) -> None:
        with self.lock:
            if success:
                self.operations += 1
            else:
                self.errors += 1
            if len(self.latencies_ms) < 100_000:
                self.latencies_ms.append(latency_ms)

    def snapshot(self) -> dict[str, float | int]:
        with self.lock:
            values = sorted(self.latencies_ms)
            result: dict[str, float | int] = {
                "operations": self.operations,
                "errors": self.errors,
                "p50_ms": percentile(values, 0.50),
                "p95_ms": percentile(values, 0.95),
                "p99_ms": percentile(values, 0.99),
                "mean_ms": statistics.fmean(values) if values else 0,
            }
            self.operations = 0
            self.errors = 0
            self.latencies_ms = []
            return result


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0
    index = min(len(values) - 1, max(0, int((len(values) - 1) * quantile)))
    return round(values[index], 2)


def choose_operation(scenario: str, rng: random.Random) -> str:
    roll = rng.random()
    if scenario == "lakebase-point-lookup":
        return "read"
    if scenario == "lakebase-transfer":
        return "write"
    if scenario == "lakebase-operational-join":
        return "complex"
    return "read" if roll < 0.55 else "write" if roll < 0.90 else "complex"


def run_worker(
    worker_id: int,
    args: argparse.Namespace,
    user: str,
    password: str,
    deadline: float,
    metrics: Metrics,
) -> None:
    rng = random.Random(args.seed + worker_id)
    with psycopg.connect(
        host=args.host,
        dbname=args.database,
        user=user,
        password=password,
        sslmode="require",
        connect_timeout=10,
        autocommit=True,
    ) as connection:
        while time.monotonic() < deadline:
            started = time.perf_counter()
            try:
                operation = choose_operation(args.scenario, rng)
                if operation == "read":
                    with connection.cursor() as cursor:
                        cursor.execute(
                            """
                            SELECT a.balance, a.region, p.price
                            FROM lakeload_bench.account a
                            CROSS JOIN lakeload_bench.product p
                            WHERE a.id = %s AND p.id = %s
                            """,
                            (rng.randint(1, 1_000_000), rng.randint(1, 10_000)),
                        )
                        cursor.fetchone()
                elif operation == "complex":
                    account_id = rng.randint(1, 1_000_000)
                    with connection.cursor() as cursor:
                        cursor.execute(
                            """
                            SELECT a.region, COUNT(h.id), COALESCE(AVG(ABS(h.amount)), 0)
                            FROM lakeload_bench.account a
                            LEFT JOIN LATERAL (
                              SELECT id, amount
                              FROM lakeload_bench.history
                              WHERE account_id = a.id
                              ORDER BY created_at DESC LIMIT 20
                            ) h ON TRUE
                            WHERE a.id = %s
                            GROUP BY a.region ORDER BY COUNT(h.id) DESC
                            """,
                            (account_id,),
                        )
                        cursor.fetchall()
                else:
                    source = rng.randint(1, 1_000_000)
                    target = source % 1_000_000 + 1
                    amount = rng.randint(1, 1_000) / 100
                    with connection.transaction(), connection.cursor() as cursor:
                        cursor.execute("UPDATE lakeload_bench.account SET balance = balance - %s WHERE id = %s", (amount, source))
                        cursor.execute("UPDATE lakeload_bench.account SET balance = balance + %s WHERE id = %s", (amount, target))
                        cursor.execute(
                            "INSERT INTO lakeload_bench.history (account_id, counterparty_id, product_id, amount) VALUES (%s, %s, 1 + MOD(%s - 1, 10000), %s)",
                            (source, target, target, amount),
                        )
                metrics.record((time.perf_counter() - started) * 1_000, True)
            except Exception:
                metrics.record((time.perf_counter() - started) * 1_000, False)


def main() -> None:
    args = parse_args()
    if not 1 <= args.concurrency <= 500:
        raise ValueError("concurrency must be between 1 and 500")
    if not 10 <= args.duration <= 3_600:
        raise ValueError("duration must be between 10 and 3600 seconds")

    workspace = WorkspaceClient()
    user = workspace.current_user.me().user_name
    credential = workspace.postgres.generate_database_credential(endpoint=args.endpoint)
    metrics = Metrics()
    deadline = time.monotonic() + args.duration

    print(json.dumps({"event": "started", "scenario": args.scenario, "concurrency": args.concurrency, "duration": args.duration}))
    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        futures = [
            executor.submit(run_worker, worker_id, args, user, credential.token, deadline, metrics)
            for worker_id in range(args.concurrency)
        ]
        second = 0
        while time.monotonic() < deadline:
            time.sleep(1)
            second += 1
            print(json.dumps({"event": "metric", "elapsed_seconds": second, **metrics.snapshot()}), flush=True)
        for future in futures:
            future.result()

    print(json.dumps({"event": "completed", "elapsed_seconds": args.duration, **metrics.snapshot()}), flush=True)


if __name__ == "__main__":
    main()
