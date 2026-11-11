import logging
import threading
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Response

from app import review, storage
from app.diagnose import diagnose
from app.evaluate import evaluate
from app.schemas import Resolution, ResolutionIn, Review, ReviewIn, RunIn, RunReport, RunRow, RunStatus, Summary

log = logging.getLogger(__name__)

# One run is evaluated at a time: the judges are local models, and two at once would fill the RAM.
one_at_a_time = threading.Lock()


def evaluate_and_diagnose(run_id: str) -> None:
    with one_at_a_time:
        stored = storage.load_one(run_id)
        if stored is None or stored.results or stored.diagnosis:
            return  # gone, or already done
        try:
            results = evaluate(stored.run)
            storage.save_evaluation(results, diagnose(stored.run, results))
        except Exception:
            # The run stays "evaluating" and is retried the next time the server starts.
            log.exception("evaluating run %s failed", run_id)


def catch_up() -> None:
    for run_id in storage.unevaluated_run_ids():
        evaluate_and_diagnose(run_id)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Evaluate any runs left waiting when the server last stopped, without delaying startup."""
    threading.Thread(target=catch_up, daemon=True).start()
    yield


app = FastAPI(title="Agent Evaluation API", lifespan=lifespan)


def start_of_today() -> datetime:
    return datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)


def find(run_id: str) -> storage.Stored:
    stored = storage.load_one(run_id)
    if stored is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return stored


@app.get("/health")
def health():
    """Quick check that the API is running."""
    return {"status": "ok"}


@app.post("/runs", response_model=RunReport, status_code=202)
def create_run(
    run_in: RunIn,
    background: BackgroundTasks,
    response: Response,
    wait: bool = Query(False, description="Wait for the scores and diagnosis instead of replying straight away (10-60 s with a local judge). Handy for demos and scripts"),
):
    """An agent sends one finished run. We store it and reply straight away with status "evaluating".
    Metrics and diagnosis run in the background; poll GET /runs/{id} every few seconds for the result."""
    run = storage.save_run(run_in)
    if wait:
        evaluate_and_diagnose(run.id)
        response.status_code = 201
        return review.report(storage.load_one(run.id))
    background.add_task(evaluate_and_diagnose, run.id)
    return review.report(storage.Stored(run))


@app.get("/runs", response_model=list[RunRow])
def list_runs(
    since: datetime | None = Query(None, description="Default: midnight today, server time"),
    agent: str | None = None,
    status: RunStatus | None = Query(None, description="e.g. needs_review for the review queue"),
):
    """Runs received since a time, newest first."""
    rows = [review.row(stored) for stored in storage.load(since=since or start_of_today(), agent=agent)]
    return [row for row in rows if status is None or row.status == status]


@app.get("/runs/{run_id}", response_model=RunReport)
def read_run(run_id: str):
    """One run with its results, diagnosis, reviews and status: the full lineage."""
    return review.report(find(run_id))


@app.post("/runs/{run_id}/reviews", response_model=Review, status_code=201)
def add_review(run_id: str, review_in: ReviewIn):
    """A person marks a metric result, or an explanation, as correct, incorrect or inconclusive.
    Never changes the result; a later review of the same thing takes precedence."""
    problem = review.review_problem(find(run_id), review_in)
    if problem:
        raise HTTPException(status_code=409, detail=problem)
    return storage.save_review(run_id, review_in)


@app.post("/runs/{run_id}/resolution", response_model=Resolution, status_code=201)
def resolve(run_id: str, resolution_in: ResolutionIn):
    """Record the action taken on a confirmed failure. A run is resolved once."""
    current = review.status(find(run_id))
    if current != "confirmed":
        raise HTTPException(status_code=409, detail=f"only confirmed failures can be resolved; this run is {current}")
    resolution = storage.save_resolution(run_id, resolution_in)
    if resolution is None:
        raise HTTPException(status_code=409, detail="this run is already resolved")
    return resolution


@app.get("/summary", response_model=Summary)
def summary(
    since: datetime | None = Query(None, description="Default: midnight today, server time"),
    agent: str | None = None,
):
    """Runs since this morning: by status and agent, failures by metric and by cause, pending reviews,
    and how often people agreed with the judge and the explanations."""
    since = since or start_of_today()
    return review.summarise(storage.load(since=since, agent=agent), since)
