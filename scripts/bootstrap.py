#!/usr/bin/env python3
"""Idempotent LakeLoad installer for a Databricks workspace."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from databricks.sdk import WorkspaceClient
from databricks.sdk.errors import NotFound
from databricks.sdk.service.catalog import PermissionsChange, Privilege
from databricks.sdk.service.postgres import (
    Branch,
    BranchSpec,
    Endpoint,
    EndpointSpec,
    EndpointType,
    Project,
    ProjectSpec,
)


ROOT = Path(__file__).resolve().parents[1]


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create LakeLoad resources and deploy the Databricks App")
    parser.add_argument("--profile", required=True, help="Authenticated Databricks CLI profile")
    parser.add_argument("--project", default="lakeload", help="Lakebase project ID")
    parser.add_argument("--app", default="lakeload", help="Databricks App name")
    parser.add_argument("--warehouse", required=True, help="SQL warehouse ID")
    parser.add_argument("--catalog", default="main", help="Unity Catalog catalog for Delta test data")
    parser.add_argument("--target", default="default", help="Bundle target")
    return parser.parse_args()


def get_or_create_project(workspace: WorkspaceClient, project_id: str):
    name = f"projects/{project_id}"
    try:
        project = workspace.postgres.get_project(name)
        print(f"reuse  {name}")
        return project
    except NotFound:
        print(f"create {name}")
        return workspace.postgres.create_project(
            project=Project(spec=ProjectSpec(display_name=project_id, pg_version=17)),
            project_id=project_id,
        ).wait()


def get_or_create_benchmark(workspace: WorkspaceClient, project_name: str):
    branch_name = f"{project_name}/branches/benchmark"
    try:
        workspace.postgres.get_branch(branch_name)
        print(f"reuse  {branch_name}")
    except NotFound:
        print(f"create {branch_name}")
        workspace.postgres.create_branch(
            parent=project_name,
            branch=Branch(spec=BranchSpec(source_branch=f"{project_name}/branches/production", no_expiry=True)),
            branch_id="benchmark",
        ).wait()

    endpoint_name = f"{branch_name}/endpoints/primary"
    try:
        endpoint = workspace.postgres.get_endpoint(endpoint_name)
        print(f"reuse  {endpoint_name}")
    except NotFound:
        print(f"create {endpoint_name}")
        endpoint = workspace.postgres.create_endpoint(
            parent=branch_name,
            endpoint=Endpoint(
                spec=EndpointSpec(
                    endpoint_type=EndpointType.ENDPOINT_TYPE_READ_WRITE,
                    autoscaling_limit_min_cu=1,
                    autoscaling_limit_max_cu=4,
                    no_suspension=True,
                )
            ),
            endpoint_id="primary",
        ).wait()
    host = endpoint.status.hosts.host
    if not host:
        raise RuntimeError(f"Endpoint {endpoint_name} did not return a PostgreSQL host")
    return branch_name, endpoint_name, host


def run(command: list[str]) -> None:
    print("run   " + " ".join(command))
    subprocess.run(command, cwd=ROOT, check=True)


def main() -> None:
    args = arguments()
    workspace = WorkspaceClient(profile=args.profile)
    workspace.current_user.me()
    project = get_or_create_project(workspace, args.project)
    project_name = project.name or f"projects/{args.project}"
    production = f"{project_name}/branches/production"
    benchmark, benchmark_endpoint, benchmark_host = get_or_create_benchmark(workspace, project_name)
    production_db = f"{production}/databases/databricks-postgres"
    benchmark_db = f"{benchmark}/databases/databricks-postgres"

    variables = {
        "postgres_project": project_name,
        "postgres_branch": production,
        "postgres_database": production_db,
        "benchmark_postgres_branch": benchmark,
        "benchmark_postgres_database": benchmark_db,
        "benchmark_postgres_endpoint": benchmark_endpoint,
        "benchmark_postgres_host": benchmark_host,
        "sql_warehouse_id": args.warehouse,
    }
    deploy = ["databricks", "bundle", "deploy", "-p", args.profile, "-t", args.target]
    for key, value in variables.items():
        deploy.extend(["--var", f"{key}={value}"])
    run(deploy)

    app = workspace.apps.get(args.app)
    principal = app.service_principal_client_id
    if not principal:
        raise RuntimeError(f"App {args.app} has no service principal")
    workspace.grants.update(
        "catalog",
        args.catalog,
        changes=[PermissionsChange(principal=principal, add=[Privilege.USE_CATALOG, Privilege.CREATE_SCHEMA])],
    )
    print(f"grant  USE CATALOG, CREATE SCHEMA on {args.catalog} to {principal}")

    run(["databricks", "bundle", "run", "app", "-p", args.profile, "-t", args.target])
    app = workspace.apps.get(args.app)
    print(f"ready  {app.url}")
    print("Open the app and click Setup > Prepare all data.")


if __name__ == "__main__":
    main()
