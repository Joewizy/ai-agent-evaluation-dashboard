"""Saving and reading runs. SQLite to start: one file, built into Python.

Each run is stored as its full JSON, plus a few columns we'll want to filter on later.
The database file is backend/evals.db unless EVAL_DB_PATH says otherwise (tests use a temp file).
"""

import os
import sqlite3
import uuid
from datetime import datetime, timezone

from app.schemas import Diagnosis, MetricResult, Run, RunIn


def db_path() -> str:
    return os.environ.get("EVAL_DB_PATH", "evals.db")


def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(db_path())
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS runs (
            id          TEXT PRIMARY KEY,
            agent_name  TEXT NOT NULL,
            mode        TEXT NOT NULL,
            received_at TEXT NOT NULL,
            data        TEXT NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS results (
            run_id    TEXT NOT NULL,
            metric_id TEXT NOT NULL,
            passed    INTEGER,
            data      TEXT NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS diagnoses (
            run_id  TEXT PRIMARY KEY,
            outcome TEXT NOT NULL,
            data    TEXT NOT NULL
        )
        """
    )
    return connection


def save_run(run_in: RunIn) -> Run:
    """Give the run an id and a time, then store it. It is never changed after this."""
    run = Run(
        **run_in.model_dump(),
        id=str(uuid.uuid4()),
        received_at=datetime.now(timezone.utc),
    )
    with connect() as connection:
        connection.execute(
            "INSERT INTO runs (id, agent_name, mode, received_at, data) VALUES (?, ?, ?, ?, ?)",
            (run.id, run.agent_name, run.mode, run.received_at.isoformat(), run.model_dump_json()),
        )
    return run


def get_run(run_id: str) -> Run | None:
    with connect() as connection:
        row = connection.execute("SELECT data FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        return None
    return Run.model_validate_json(row[0])


def save_results(results: list[MetricResult]) -> None:
    """Results are stored separately from the run, so the run itself is never changed."""
    with connect() as connection:
        connection.executemany(
            "INSERT INTO results (run_id, metric_id, passed, data) VALUES (?, ?, ?, ?)",
            [(result.run_id, result.metric_id, result.passed, result.model_dump_json()) for result in results],
        )


def get_results(run_id: str) -> list[MetricResult]:
    with connect() as connection:
        rows = connection.execute(
            "SELECT data FROM results WHERE run_id = ? ORDER BY metric_id", (run_id,)
        ).fetchall()
    return [MetricResult.model_validate_json(row[0]) for row in rows]


def save_diagnosis(diagnosis: Diagnosis) -> None:
    """Stored separately from the run and its results, so neither is ever changed."""
    with connect() as connection:
        connection.execute(
            "INSERT INTO diagnoses (run_id, outcome, data) VALUES (?, ?, ?)",
            (diagnosis.run_id, diagnosis.outcome, diagnosis.model_dump_json()),
        )


def get_diagnosis(run_id: str) -> Diagnosis | None:
    with connect() as connection:
        row = connection.execute("SELECT data FROM diagnoses WHERE run_id = ?", (run_id,)).fetchone()
    if row is None:
        return None
    return Diagnosis.model_validate_json(row[0])
