"""Human review, run status and the "since this morning" summary (Phase 2).

Status comes from what's stored, it's never stored itself:
  evaluating -> passed / could_not_run / needs_review -> confirmed or false_alarm -> resolved

Only failed metric results decide needs_review / confirmed / false_alarm. A metric's YAML says how its failures
are settled:
  review: person  an AI judge or a rule that can be wrong decided it, so it waits for a person
  review: auto    it's a measurement (time, cost, an error the agent recorded), so it's real without a review
One person-reviewed failure marked correct is enough to confirm (there's a real problem to act on). Otherwise the
run waits while any person-reviewed failure is unreviewed; then a measured failure confirms it, and if every failure
was marked incorrect it's a false alarm.
A person can still review a passed result or an explanation; those reviews feed the judge and diagnosis accuracy
numbers. Measured results can't be reviewed. The latest review of the same thing counts. "Inconclusive" leaves it
waiting for someone else.
"""

from collections import Counter, defaultdict
from datetime import datetime

from app.evaluate import load_metrics
from app.schemas import (
    Action,
    AgentSummary,
    MetricSummary,
    Review,
    ReviewCount,
    ReviewIn,
    RunReport,
    RunRow,
    RunStatus,
    Summary,
)
from app.storage import Stored

NO_EXPLANATION = "no_explanation"
OTHER = "other"


def latest(reviews: list[Review]) -> dict[tuple, Review]:
    """The latest review of each thing reviewed. Reviews arrive oldest first."""
    found = {}
    for review in reviews:
        found[(review.target, review.metric_id, review.explanation)] = review
    return found


def status(stored: Stored) -> RunStatus:
    if stored.diagnosis is None and not stored.results:
        return "evaluating"
    if stored.resolution is not None:
        return "resolved"
    failed = [result for result in stored.results if result.passed is False]
    if not failed:
        return "could_not_run" if any(r.skipped_because == "could_not_run" for r in stored.results) else "passed"
    reviewed = latest(stored.reviews)
    verdicts = [
        getattr(reviewed.get(("metric_result", result.metric_id, None)), "verdict", None)
        for result in failed
        if result.review == "person"
    ]
    if "correct" in verdicts:
        return "confirmed"  # one real failure is enough to act on
    if any(verdict != "incorrect" for verdict in verdicts):
        return "needs_review"  # something a person has to judge is still waiting
    if any(result.review == "auto" for result in failed):
        return "confirmed"  # measured, so it's real without a review
    return "false_alarm"


def report(stored: Stored) -> RunReport:
    return RunReport(
        run=stored.run,
        status=status(stored),
        results=stored.results,
        diagnosis=stored.diagnosis,
        reviews=stored.reviews,
        resolution=stored.resolution,
    )


def causes(stored: Stored) -> list[str]:
    """Why a failed run failed, as pattern names. Only for runs where something failed."""
    if not any(result.passed is False for result in stored.results):
        return []
    explanations = stored.diagnosis.explanations if stored.diagnosis else []
    if not explanations:
        return [NO_EXPLANATION]
    return list(dict.fromkeys(explanation.pattern or OTHER for explanation in explanations))


def row(stored: Stored) -> RunRow:
    return RunRow(
        id=stored.run.id,
        agent_name=stored.run.agent_name,
        mode=stored.run.mode,
        received_at=stored.run.received_at,
        status=status(stored),
        failed_metrics=[result.metric_id for result in stored.results if result.passed is False],
        causes=causes(stored),
    )


def review_problem(stored: Stored, review: ReviewIn) -> str | None:
    """Why this review can't be accepted, or None if it can."""
    if status(stored) == "evaluating":
        return "the run is still being evaluated"
    if review.target == "metric_result":
        result = next((r for r in stored.results if r.metric_id == review.metric_id), None)
        if result is None:
            return f"this run has no result for metric '{review.metric_id}'"
        if result.passed is None:
            return f"metric '{review.metric_id}' was skipped, so there's no result to review"
        if result.review == "auto":
            return f"metric '{review.metric_id}' is a measurement, so it's confirmed without a review"
        return None
    count = len(stored.diagnosis.explanations) if stored.diagnosis else 0
    if review.explanation >= count:
        return f"this run's diagnosis has {count} explanation(s), numbered from 0"
    return None


def count_reviews(reviews: list[Review]) -> ReviewCount:
    counts = Counter(review.verdict for review in reviews)
    decided = counts["correct"] + counts["incorrect"]
    return ReviewCount(
        correct=counts["correct"],
        incorrect=counts["incorrect"],
        inconclusive=counts["inconclusive"],
        agreement=round(counts["correct"] / decided, 2) if decided else None,
    )


def summarise(runs: list[Stored], since: datetime) -> Summary:
    names = {metric.id: metric.name for metric in load_metrics()}
    statuses = Counter()
    agents: dict[str, AgentSummary] = defaultdict(AgentSummary)
    metrics: dict[str, MetricSummary] = {}
    scores: dict[str, list[float]] = defaultdict(list)
    failure_causes = Counter()
    failed_runs = several_causes = 0
    judge_reviews, explanation_reviews = [], []

    for stored in runs:
        run_status = status(stored)
        statuses[run_status] += 1
        agent = agents[stored.run.agent_name]
        agent.runs += 1
        if any(result.passed is False for result in stored.results):
            agent.failed += 1
            failed_runs += 1
            run_causes = causes(stored)
            failure_causes.update(run_causes)
            several_causes += len(run_causes) > 1
        elif run_status == "could_not_run":
            agent.could_not_run += 1

        for result in stored.results:
            metric = metrics.setdefault(result.metric_id, MetricSummary(name=names.get(result.metric_id, result.metric_id)))
            if result.skipped_because == "could_not_run":
                metric.could_not_run += 1
            elif result.skipped_because == "missing_data":
                metric.missing_data += 1
            else:
                metric.scored += 1
                metric.failed += result.passed is False
                scores[result.metric_id].append(result.score)

        methods = {result.metric_id: result.method for result in stored.results}
        for review in latest(stored.reviews).values():
            if review.target == "explanation":
                explanation_reviews.append(review)
            elif methods.get(review.metric_id) == "llm_judge":
                judge_reviews.append(review)

    for metric_id, values in scores.items():
        metrics[metric_id].average_score = round(sum(values) / len(values), 2)

    return Summary(
        since=since,
        runs=len(runs),
        by_status=dict(statuses),
        by_agent=dict(agents),
        metrics=dict(sorted(metrics.items())),
        failed_runs=failed_runs,
        failures_by_cause=dict(failure_causes.most_common()),
        runs_with_several_causes=several_causes,
        pending_reviews=statuses["needs_review"],
        actions=sorted(
            (
                Action(run_id=s.run.id, agent_name=s.run.agent_name, **s.resolution.model_dump(exclude={"run_id"}))
                for s in runs
                if s.resolution
            ),
            key=lambda action: action.resolved_at,
            reverse=True,
        ),
        judge_vs_humans=count_reviews(judge_reviews),
        explanations_reviewed=count_reviews(explanation_reviews),
    )
