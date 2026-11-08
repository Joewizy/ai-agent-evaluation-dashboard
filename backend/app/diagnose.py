"""Diagnosis: what the evidence shows and what might explain a failure. See docs/DIAGNOSIS_DESIGN.md.

Reads the run and its metric results. Never changes either of them.

Built so far: the outcome only (step 2). Observations come in step 3 and explanations in step 4,
so for now a failed run always ends up as "insufficient_evidence".
"""

from datetime import datetime, timezone

from app.schemas import Diagnosis, MetricResult, Run

DIAGNOSIS_VERSION = "diagnosis-v0"


def diagnose(run: Run, results: list[MetricResult]) -> Diagnosis:
    failed = [result for result in results if result.passed is False]
    could_not_run = [result for result in results if result.skipped_because == "could_not_run"]
    missing_data = [result for result in results if result.skipped_because == "missing_data"]

    caveats = [f"'{result.metric_id}' couldn't run: {result.skipped_reason}." for result in could_not_run]
    caveats += [f"'{result.metric_id}' skipped, missing data: {result.skipped_reason}." for result in missing_data]

    # Skipped isn't passed: if a metric couldn't run, we can't say nothing went wrong.
    if not failed and not could_not_run:
        outcome = "not_needed"
    else:
        outcome = "insufficient_evidence"

    return Diagnosis(
        run_id=run.id,
        outcome=outcome,
        caveats=caveats,
        method="rules",
        version=DIAGNOSIS_VERSION,
        diagnosed_at=datetime.now(timezone.utc),
    )
