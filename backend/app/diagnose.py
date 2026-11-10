"""Diagnosis: what the evidence shows and what might explain a failure. See notes/design.md.

Reads the run and its metric results. Never changes either of them.

Explanations are leads, not verdicts. There can be several or none, they aren't ranked, and each one
points at the observations it rests on. "What to do" is always something to check, never a fix.
"""

from datetime import datetime, timezone

from app.checks import simplify
from app.evidence import (
    KEY_FACTS,
    KeyFactCheck,
    check_key_facts,
    claim_id,
    collect_observations,
    is_judge_problem,
    problem_prefix,
    quote_found_id,
    quote_not_found_id,
    step_error_id,
    step_order_id,
)
from app.schemas import Diagnosis, Evidence, Explanation, MetricResult, Run

DIAGNOSIS_VERSION = "diagnosis-v2"


def diagnose(run: Run, results: list[MetricResult]) -> Diagnosis:
    failed = [result for result in results if result.passed is False]
    could_not_run = [result for result in results if result.skipped_because == "could_not_run"]
    missing_data = [result for result in results if result.skipped_because == "missing_data"]

    key_facts = check_key_facts(run, results)
    observations = collect_observations(run, results, key_facts)
    known = {observation.id for observation in observations}
    explanations = explain(run, results, key_facts, known) if failed else []

    caveats = [f"'{result.metric_id}' couldn't run: {result.skipped_reason}." for result in could_not_run]
    caveats += [f"'{result.metric_id}' skipped, missing data: {result.skipped_reason}." for result in missing_data]
    caveats += [f"Judge check: {observation.text}" for observation in observations if is_judge_problem(observation.id)]
    if key_facts.caveat:
        caveats.append(key_facts.caveat)

    # Skipped isn't passed: if a metric couldn't run, we can't say nothing went wrong.
    if explanations:
        outcome = "explanations_found"
    elif not failed and not could_not_run:
        outcome = "not_needed"
    else:
        outcome = "insufficient_evidence"

    return Diagnosis(
        run_id=run.id,
        outcome=outcome,
        observations=observations,
        explanations=explanations,
        caveats=caveats,
        method="rules+judge" if key_facts.facts else "rules",
        version=DIAGNOSIS_VERSION,
        diagnosed_at=datetime.now(timezone.utc),
    )


def explain(run: Run, results: list[MetricResult], key_facts: KeyFactCheck, known: set[str]) -> list[Explanation]:
    by_metric = {result.metric_id: result for result in results}
    grounded = by_metric.get("groundedness")
    correct = by_metric.get("correctness")

    found = [
        answer_contradicts_context(grounded, known),
        claim_not_in_context(grounded, correct, known),
        context_disagrees_with_answer_key(grounded, correct, key_facts, known),
        fact_missing_from_context(key_facts, known),
    ]
    return [explanation for explanation in found if explanation] + tool_failures(run, results, known)


def claims_with(result: MetricResult | None, verdict: str) -> list[tuple[int, Evidence]]:
    """(number, evidence) for the claims with this verdict. Numbers match the observation ids."""
    if result is None:
        return []
    return [(number, evidence) for number, evidence in enumerate(result.evidence, start=1) if evidence.verdict == verdict]


def quote_support(metric_id: str, number: int, known: set[str]) -> tuple[list[str], list[str]]:
    """What the code checks add to one judged claim, as (ids that back it up, ids that count against it).

    A found quote only backs the judge up if nothing else about its answer looks wrong.
    """
    prefix = problem_prefix(metric_id, number)
    problems = sorted(observation_id for observation_id in known if observation_id.startswith(prefix))
    not_found = quote_not_found_id(metric_id, number)
    found = quote_found_id(metric_id, number)
    return ([found] if found in known and not problems else []), problems + ([not_found] if not_found in known else [])


def answer_contradicts_context(grounded: MetricResult | None, known: set[str]) -> Explanation | None:
    contradicted = claims_with(grounded, "failed")
    if grounded is None or grounded.passed is not False or not contradicted:
        return None

    supported_by, weakened_by, how_to_check = [], [], []
    for number, evidence in contradicted:
        found, doubts = quote_support("groundedness", number, known)
        supported_by += [claim_id("groundedness", number), *found]
        weakened_by += doubts
        how_to_check.append(f'Re-run with the same sources. Does it still say "{evidence.item}"?')

    return Explanation(
        summary="The agent may not have used what it looked up.",
        pattern="answer_contradicts_context",
        supported_by=supported_by,
        weakened_by=weakened_by,
        how_to_check=how_to_check,
        who_could_look="whoever owns the agent's instructions",
    )


def claim_not_in_context(
    grounded: MetricResult | None, correct: MetricResult | None, known: set[str]
) -> Explanation | None:
    not_mentioned = claims_with(grounded, "missing")
    if grounded is None or grounded.passed is not False or not not_mentioned:
        return None

    matches_key = {simplify(evidence.item): number for number, evidence in claims_with(correct, "passed")}
    supported_by, weakened_by, how_to_check = [], [], []
    for number, evidence in not_mentioned:
        supported_by.append(claim_id("groundedness", number))
        weakened_by += quote_support("groundedness", number, known)[1]
        if simplify(evidence.item) in matches_key:
            weakened_by.append(claim_id("correctness", matches_key[simplify(evidence.item)]))
        how_to_check.append(
            f'Search what the agent looked up for "{evidence.item}". If it\'s there, the judge missed it.'
        )

    return Explanation(
        summary="The agent may have added something that isn't in what it looked up.",
        pattern="claim_not_in_context",
        supported_by=supported_by,
        weakened_by=weakened_by,
        how_to_check=how_to_check,
        who_could_look="whoever owns the agent's instructions or its document search",
    )


def context_disagrees_with_answer_key(
    grounded: MetricResult | None, correct: MetricResult | None, key_facts: KeyFactCheck, known: set[str]
) -> Explanation | None:
    """The sources and the answer key say different things. We don't decide which of them is wrong.

    Claims are matched on their text. If the judge split them differently, no match means no explanation.
    """
    if correct is None or correct.passed is not False:
        return None

    backed_by_sources = {simplify(evidence.item): number for number, evidence in claims_with(grounded, "passed")}
    supported_by, weakened_by, how_to_check = [], [], []
    for number, evidence in claims_with(correct, "failed"):
        source_number = backed_by_sources.get(simplify(evidence.item))
        if source_number is None:
            continue
        source_found, source_doubts = quote_support("groundedness", source_number, known)
        key_found, key_doubts = quote_support("correctness", number, known)
        supported_by += [claim_id("groundedness", source_number), *source_found, claim_id("correctness", number), *key_found]
        weakened_by += source_doubts + key_doubts
        how_to_check.append(f'Check "{evidence.item}" against the original. Is the source or the answer key out of date?')

    for number, evidence in enumerate(key_facts.facts, start=1):
        if evidence.verdict != "failed":
            continue
        found, doubts = quote_support(KEY_FACTS, number, known)
        supported_by += [claim_id(KEY_FACTS, number), *found]
        weakened_by += doubts
        how_to_check.append(f'Check "{evidence.item}" against the original. Is the source or the answer key out of date?')

    if not supported_by:
        return None
    return Explanation(
        summary="The sources and the answer key disagree. The source may be out of date, or the answer key may be wrong.",
        pattern="context_disagrees_with_answer_key",
        supported_by=supported_by,
        weakened_by=weakened_by,
        how_to_check=how_to_check,
        who_could_look="whoever maintains the answer key and the documents",
    )


def fact_missing_from_context(key_facts: KeyFactCheck, known: set[str]) -> Explanation | None:
    """A key fact wasn't in what the agent looked up. It doesn't prove search failed."""
    supported_by, weakened_by, how_to_check = [], [], []
    for number, evidence in enumerate(key_facts.facts, start=1):
        if evidence.verdict != "missing":
            continue
        supported_by.append(claim_id(KEY_FACTS, number))
        weakened_by += quote_support(KEY_FACTS, number, known)[1]
        how_to_check.append(f'Look for "{evidence.item}" in the documents. If it\'s there, search or the judge missed it.')

    if not supported_by:
        return None
    return Explanation(
        summary="The agent may not have had a fact it needed. That could point to search, the documents, or the question.",
        pattern="fact_missing_from_context",
        supported_by=supported_by,
        weakened_by=weakened_by,
        how_to_check=how_to_check,
        who_could_look="whoever owns the agent's document search and documents",
    )


def tool_failures(run: Run, results: list[MetricResult], known: set[str]) -> list[Explanation]:
    """One explanation per failed step. A failed step may be related to a wrong answer without causing it."""
    judged = [result for result in results if result.judge_model]
    judge_incomplete = any(result.skipped_because == "could_not_run" for result in results)
    verdicts = [evidence.verdict for result in judged for evidence in result.evidence]
    answer_looks_fine = (
        bool(verdicts)
        and not judge_incomplete
        and all(verdict == "passed" for verdict in verdicts)
        and not any(is_judge_problem(observation_id) for observation_id in known)
    )

    grounded = next((result for result in results if result.metric_id == "groundedness"), None)
    found_anyway: list[str] = []
    for number, _ in claims_with(grounded, "failed"):
        found_anyway += quote_support("groundedness", number, known)[0]

    explanations = []
    for position, step in enumerate(run.steps, start=1):
        if not step.error:
            continue
        supported_by = [step_error_id(position, step)]
        if step_order_id(position, step) in known:
            supported_by.append(step_order_id(position, step))

        if answer_looks_fine:
            supported_by += [
                claim_id(result.metric_id, number) for result in judged for number in range(1, len(result.evidence) + 1)
            ]
            summary = f"The failed step '{step.name}' may be a problem on its own, without affecting the answer."
            how_to_check = [f"Re-run with '{step.name}' working. Does the answer stay the same?"]
            weakened_by = []
        else:
            summary = f"The failed step '{step.name}' may have affected the answer."
            how_to_check = [f"Re-run with '{step.name}' working. Does the answer change?"]
            weakened_by = found_anyway  # the information was available even though this step failed

        explanations.append(
            Explanation(
                summary=summary,
                pattern="tool_failure",
                supported_by=supported_by,
                weakened_by=weakened_by,
                how_to_check=[*how_to_check, f"Check the logs for '{step.name}' around this run."],
                who_could_look=f"whoever owns '{step.name}'",
            )
        )
    return explanations
