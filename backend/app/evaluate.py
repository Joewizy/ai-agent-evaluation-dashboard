"""Run every metric that applies to a run and collect the results."""

from datetime import datetime, timezone
from pathlib import Path

import yaml

from app.checks import CHECKS
from app.schemas import Metric, MetricResult, Run

METRICS_FOLDER = Path(__file__).parent / "metrics"


def load_metrics() -> list[Metric]:
    """Read every YAML file in app/metrics/. Read fresh each time, so edits apply without a restart."""
    metrics = []
    for path in sorted(METRICS_FOLDER.glob("*.yaml")):
        metric = Metric(**yaml.safe_load(path.read_text()))
        if metric.check not in CHECKS:
            raise ValueError(f"{path.name}: unknown check '{metric.check}'. Known: {', '.join(CHECKS)}")
        metrics.append(metric)
    return metrics


def applies_to(metric: Metric, run: Run) -> bool:
    if not metric.enabled:
        return False
    if run.mode not in metric.modes:
        return False
    if metric.agents and run.agent_name not in metric.agents:
        return False
    return True


def evaluate(run: Run) -> list[MetricResult]:
    results = []
    for metric in load_metrics():
        metric = metric.for_agent(run.agent_name)
        if not applies_to(metric, run):
            continue

        outcome = CHECKS[metric.check](run, metric)
        skipped = outcome.score is None
        score = None if skipped else round(outcome.score, 2)
        results.append(
            MetricResult(
                run_id=run.id,
                metric_id=metric.id,
                score=score,
                threshold=metric.threshold,
                settings=metric.settings,
                passed=None if skipped else score >= metric.threshold,
                reason=f"Skipped: {outcome.skipped_reason}." if skipped else outcome.reason,
                evidence=outcome.evidence,
                skipped_reason=outcome.skipped_reason,
                skipped_because=None if not skipped else ("could_not_run" if outcome.could_not_run else "missing_data"),
                method=metric.method,
                review=metric.review,
                judge_model=outcome.judge_model,
                judge_prompt_version=outcome.judge_prompt_version,
                evaluated_at=datetime.now(timezone.utc),
            )
        )
    return results
