"""Saving and reading runs. SQLite to start: one file, built into Python.

Each thing is stored as its full JSON, plus a few columns we filter on.
Nothing is ever updated: results, diagnoses, reviews and resolutions are stored next to the run.
The database file is backend/evals.db unless EVAL_DB_PATH says otherwise (tests use a temp file).
"""

import json
import os
import sqlite3
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone

from app.evaluate import load_metrics
from app.schemas import Diagnosis, Metric, MetricResult, Resolution, ResolutionIn, Review, ReviewIn, Run, RunIn

TABLES = """
CREATE TABLE IF NOT EXISTS runs (
    id          TEXT PRIMARY KEY,
    agent_name  TEXT NOT NULL,
    mode        TEXT NOT NULL,
    received_at TEXT NOT NULL,
    data        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
    run_id    TEXT NOT NULL,
    metric_id TEXT NOT NULL,
    passed    INTEGER,
    data      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS diagnoses (
    run_id  TEXT PRIMARY KEY,
    outcome TEXT NOT NULL,
    data    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    data        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resolutions (
    run_id TEXT PRIMARY KEY,
    data   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_received_at ON runs (received_at);
CREATE INDEX IF NOT EXISTS results_run_id ON results (run_id);
CREATE INDEX IF NOT EXISTS reviews_run_id ON reviews (run_id);
"""


def db_path() -> str:
    return os.environ.get("EVAL_DB_PATH", "evals.db")


def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(db_path())
    connection.executescript(TABLES)
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
    return None if row is None else Run.model_validate_json(row[0])


def save_evaluation(results: list[MetricResult], diagnosis: Diagnosis) -> None:
    """Results and diagnosis are saved together, so a crash never leaves a run half evaluated."""
    with connect() as connection:
        connection.executemany(
            "INSERT INTO results (run_id, metric_id, passed, data) VALUES (?, ?, ?, ?)",
            [(result.run_id, result.metric_id, result.passed, result.model_dump_json()) for result in results],
        )
        connection.execute(
            "INSERT INTO diagnoses (run_id, outcome, data) VALUES (?, ?, ?)",
            (diagnosis.run_id, diagnosis.outcome, diagnosis.model_dump_json()),
        )


def unevaluated_run_ids() -> list[str]:
    """Runs with no results and no diagnosis, e.g. because the server stopped while they waited."""
    with connect() as connection:
        rows = connection.execute(
            """SELECT id FROM runs
               WHERE id NOT IN (SELECT run_id FROM results) AND id NOT IN (SELECT run_id FROM diagnoses)
               ORDER BY received_at"""
        ).fetchall()
    return [row[0] for row in rows]


def save_review(run_id: str, review_in: ReviewIn) -> Review:
    review = Review(**review_in.model_dump(), id=str(uuid.uuid4()), run_id=run_id, reviewed_at=datetime.now(timezone.utc))
    with connect() as connection:
        connection.execute(
            "INSERT INTO reviews (id, run_id, reviewed_at, data) VALUES (?, ?, ?, ?)",
            (review.id, run_id, review.reviewed_at.isoformat(), review.model_dump_json()),
        )
    return review


def save_resolution(run_id: str, resolution_in: ResolutionIn) -> Resolution | None:
    """Returns None if the run was already resolved: a resolution is never overwritten."""
    resolution = Resolution(**resolution_in.model_dump(), run_id=run_id, resolved_at=datetime.now(timezone.utc))
    try:
        with connect() as connection:
            connection.execute("INSERT INTO resolutions (run_id, data) VALUES (?, ?)", (run_id, resolution.model_dump_json()))
    except sqlite3.IntegrityError:
        return None
    return resolution


def parse_result(data: str, run: Run, metrics: dict[str, Metric]) -> MetricResult:
    """Results saved before `review` was recorded take the metric's current review mode.

    The review mode describes how a failure is settled, not the measurement, so a result scored by older code
    is read the same way a new one would be: a slow run is confirmed without a review, not queued for one.
    `settings` are not filled in: an old score was computed under the settings of its time, which are unknown.
    """
    raw = json.loads(data)
    if "review" not in raw and raw.get("metric_id") in metrics:
        raw["review"] = metrics[raw["metric_id"]].for_agent(run.agent_name).review
    return MetricResult.model_validate(raw)


@dataclass
class Stored:
    """Everything stored about one run."""

    run: Run
    results: list[MetricResult] = field(default_factory=list)
    diagnosis: Diagnosis | None = None
    reviews: list[Review] = field(default_factory=list)
    resolution: Resolution | None = None


def load(run_id: str | None = None, since: datetime | None = None, agent: str | None = None) -> list[Stored]:
    """One run by id, or every run received since a time (optionally for one agent), newest first."""
    where, params = [], []
    if run_id is not None:
        where.append("runs.id = ?")
        params.append(run_id)
    if since is not None:
        where.append("runs.received_at >= ?")
        params.append(since.astimezone(timezone.utc).isoformat())
    if agent is not None:
        where.append("runs.agent_name = ?")
        params.append(agent)
    clause = ("WHERE " + " AND ".join(where)) if where else ""

    with connect() as connection:

        def rows(table: str, order: str = "") -> list[tuple[str, str]]:
            """(run_id, data) for every row of a table that belongs to the selected runs."""
            return connection.execute(
                f"SELECT t.run_id, t.data FROM {table} t JOIN runs ON runs.id = t.run_id {clause} {order}", params
            ).fetchall()

        runs = connection.execute(f"SELECT data FROM runs {clause} ORDER BY received_at DESC", params).fetchall()
        stored = {run.id: Stored(run) for run in (Run.model_validate_json(row[0]) for row in runs)}
        results = rows("results", "ORDER BY t.metric_id")
        diagnoses = rows("diagnoses")
        reviews = rows("reviews", "ORDER BY t.reviewed_at")
        resolutions = rows("resolutions")

    metrics = {metric.id: metric for metric in load_metrics()}
    grouped = defaultdict(list)
    for run_id_, data in results:
        grouped[run_id_].append(parse_result(data, stored[run_id_].run, metrics))
    for run_id_, items in grouped.items():
        stored[run_id_].results = items
    for run_id_, data in diagnoses:
        stored[run_id_].diagnosis = Diagnosis.model_validate_json(data)
    for run_id_, data in reviews:
        stored[run_id_].reviews.append(Review.model_validate_json(data))
    for run_id_, data in resolutions:
        stored[run_id_].resolution = Resolution.model_validate_json(data)
    return list(stored.values())


def load_one(run_id: str) -> Stored | None:
    found = load(run_id=run_id)
    return found[0] if found else None
