"""Evidence collection: turn a run and its metric results into observations.

Observations are things we saw, and each one says how we know it:
  recorded = as the agent sent it, not checked by us
  computed = a deterministic check our code ran; the text states only what was checked
  judged   = the AI judge's opinion, which could be wrong

A quote being found is computed. That the quote supports the claim is judged. Text here must keep those apart.

The ids are built from positions in the run and its results, which never change, so they're stable.
"""

from dataclasses import dataclass, field

from app import checks, judge
from app.checks import tool_results
from app.quotes import find_quote
from app.judge_checks import answer_problems, quote_problems
from app.schemas import Evidence, MetricResult, Observation, Ref, Run, Step

KEY_FACTS = "key-facts"   # the check, made during diagnosis, of the answer key's facts against the sources
REFERENCE_NAMES = {"groundedness": "the sources", "correctness": "the answer key", KEY_FACTS: "the sources"}
VERDICT_WORDS = {"passed": "supported by", "failed": "contradicted by", "missing": "not mentioned in"}


def step_error_id(position: int, step: Step) -> str:
    return f"step-{position}-{step.name}-error"


def step_order_id(position: int, step: Step) -> str:
    return f"step-{position}-{step.name}-answer-step-ran-after"


def claim_id(metric_id: str, number: int) -> str:
    return f"{metric_id}-claim-{number}"


def quote_found_id(metric_id: str, number: int) -> str:
    return f"{claim_id(metric_id, number)}-quote-found"


def quote_not_found_id(metric_id: str, number: int) -> str:
    return f"{claim_id(metric_id, number)}-quote-not-found"


def problem_prefix(metric_id: str, number: int) -> str:
    return f"{claim_id(metric_id, number)}-problem-"


def is_judge_problem(observation_id: str) -> bool:
    return "-problem-" in observation_id or observation_id.endswith("-quote-not-found")


@dataclass
class KeyFactCheck:
    """Whether the answer key's uncovered facts were in what the agent looked up."""

    facts: list[Evidence] = field(default_factory=list)
    model: str | None = None
    caveat: str | None = None


def check_key_facts(run: Run, results: list[MetricResult]) -> KeyFactCheck:
    """One judge call, only when "Correct answer" failed, the agent looked something up, and key facts weren't covered."""
    correct = next((result for result in results if result.metric_id == "correctness"), None)
    if correct is None or correct.passed is not False or not correct.judge_model:
        return KeyFactCheck()
    facts = [e.item for e in correct.evidence if e.verdict in ("left_out", "key_contradicted")]
    sources = checks.sources_for(run)
    if not facts or not sources:
        return KeyFactCheck()
    try:
        checked, _ = checks.check_claims(facts, sources, correct.judge_model)
    except judge.JudgeError as error:
        return KeyFactCheck(caveat=f"Couldn't check whether the answer key's facts were in the sources: {error}.")
    return KeyFactCheck(facts=checked, model=correct.judge_model)


def collect_observations(run: Run, results: list[MetricResult], key_facts: KeyFactCheck | None = None) -> list[Observation]:
    observations = step_observations(run)
    for result in results:
        if result.judge_model:
            ref = Ref(kind="metric_result", id=result.metric_id)
            observations += claim_observations(run, result.metric_id, result.evidence, result.judge_model, ref)
        elif result.method == "code" and result.passed is False:
            observations.append(
                Observation(
                    id=f"{result.metric_id}-failed",
                    text=result.reason,
                    basis="computed",
                    refs=[Ref(kind="metric_result", id=result.metric_id)],
                )
            )
    if key_facts and key_facts.facts:
        ref = Ref(kind="expected_output", id="expected_output")
        observations += claim_observations(run, KEY_FACTS, key_facts.facts, key_facts.model, ref, noun="the answer key's fact")
    return observations


def step_ref(position: int, step: Step) -> Ref:
    return Ref(kind="step", id=step.name, detail=f"step {position}")


def step_observations(run: Run) -> list[Observation]:
    observations = []
    for position, step in enumerate(run.steps, start=1):
        if not step.error:
            continue
        observations.append(
            Observation(
                id=step_error_id(position, step),
                text=f"Step '{step.name}' reported an error: {step.error}",
                basis="recorded",
                refs=[step_ref(position, step)],
            )
        )
        later_llm_calls = [
            (later, other)
            for later, other in enumerate(run.steps, start=1)
            if later > position and other.type == "llm_call"
        ]
        if later_llm_calls:
            later, other = later_llm_calls[-1]
            observations.append(
                Observation(
                    id=step_order_id(position, step),
                    text=f"Step '{other.name}' ran after the failed step '{step.name}'.",
                    basis="recorded",
                    refs=[step_ref(position, step), step_ref(later, other)],
                )
            )
    return observations


def places_to_look(run: Run, metric_id: str) -> list[tuple[str, Ref, str]]:
    """The texts a judge was checking against, as (name, where it is, text)."""
    if metric_id == "correctness" and run.expected_output:
        return [("the answer key", Ref(kind="expected_output", id="expected_output"), run.expected_output)]
    if metric_id not in ("groundedness", KEY_FACTS):
        return []
    places = [("the agent's instructions", Ref(kind="instructions", id="instructions"), run.instructions)] if run.instructions else []
    places += [
        (f"context {number}", Ref(kind="context", id=str(number)), text)
        for number, text in enumerate(run.context, start=1)
    ]
    places += [(f"the result of step '{step.name}'", step_ref(position, step), text) for position, step, text in tool_results(run)]
    return places


def claim_observations(
    run: Run, metric_id: str, items: list[Evidence], model: str, base_ref: Ref, noun: str = "the claim"
) -> list[Observation]:
    """For each item: the judge's verdict, what our code found about its quote, and any problem with its answer."""
    observations = []
    reference = REFERENCE_NAMES.get(metric_id, "the reference")

    for number, evidence in enumerate(items, start=1):
        ref = base_ref.model_copy(update={"detail": evidence.item})
        observations.append(
            Observation(
                id=claim_id(metric_id, number),
                text=claim_text(evidence, reference, noun),
                basis="judged",
                refs=[ref],
                judge_model=model,
            )
        )
        if evidence.verdict not in VERDICT_WORDS:
            continue  # a key fact compared with the answer: there's nothing further to check

        problems = answer_problems(evidence)
        if evidence.source:
            quote = quote_observation(run, metric_id, number, evidence.source, reference, ref)
            observations.append(quote)
            if quote.id == quote_found_id(metric_id, number):
                problems += quote_problems(evidence)
        observations += [
            Observation(id=f"{problem_prefix(metric_id, number)}{name}", text=text, basis="computed", refs=[ref])
            for name, text in problems
        ]
    return observations


def claim_text(evidence: Evidence, reference: str, noun: str) -> str:
    if evidence.verdict == "left_out":
        return f'The judge found the answer key\'s fact "{evidence.item}" left out of the answer.'
    if evidence.verdict == "key_contradicted":
        return f'The judge found the answer key\'s fact "{evidence.item}" contradicted by the answer.'
    return f'The judge found {noun} "{evidence.item}" {VERDICT_WORDS[evidence.verdict]} {reference}.'


def quote_observation(run: Run, metric_id: str, number: int, quote: str, reference: str, claim_ref: Ref) -> Observation:
    for name, place, text in places_to_look(run, metric_id):
        found = find_quote(quote, text)
        if found:
            how = (
                "word for word (ignoring case and spacing)"
                if found == "exact"
                else "reworded: the same names and numbers are in one record, but not in these words"
            )
            # This observation records only that the quotation exists. Whether it supports the claim remains the judge's verdict.
            return Observation(
                id=quote_found_id(metric_id, number),
                text=f'The judge\'s quote "{quote}" is in {name}, {how}.',
                basis="computed",
                refs=[claim_ref, place],
                match=found,
            )
    return Observation(
        id=quote_not_found_id(metric_id, number),
        text=f'The judge\'s quote "{quote}" was not found in {reference}.',
        basis="computed",
        refs=[claim_ref],
    )
