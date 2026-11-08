from fastapi import FastAPI, HTTPException

from app import storage
from app.diagnose import diagnose
from app.evaluate import evaluate
from app.schemas import RunIn, RunReport

app = FastAPI(title="Agent Evaluation API")


@app.get("/health")
def health():
    """Quick check that the API is running."""
    return {"status": "ok"}


@app.post("/runs", response_model=RunReport, status_code=201)
def create_run(run_in: RunIn):
    """An agent sends one finished run. We store it, run every metric, diagnose any failures, and return it all."""
    run = storage.save_run(run_in)
    results = evaluate(run)
    storage.save_results(results)
    diagnosis = diagnose(run, results)
    storage.save_diagnosis(diagnosis)
    return RunReport(run=run, results=results, diagnosis=diagnosis)


@app.get("/runs/{run_id}", response_model=RunReport)
def read_run(run_id: str):
    """Read back one stored run with its results and diagnosis."""
    run = storage.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return RunReport(run=run, results=storage.get_results(run_id), diagnosis=storage.get_diagnosis(run_id))
