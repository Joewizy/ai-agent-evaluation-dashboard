"""Selective second opinion. See notes/design.md, "When the evaluation judge itself is wrong".

Only runs when an explanation rests on a judged observation. A different model re-checks just those
claims, against the same text the first judge used. Each re-check is kept as a SecondOpinion record.

The goal isn't two judges that agree, it's leads that hold up. If one judge says a claim is supported
and the other doesn't, explanations resting on it are set aside, with a caveat. If both say it isn't
supported and differ only on contradicted vs not mentioned, the lead stays and the caveat says so:
on real runs that was the most common disagreement, and it doesn't change pass or fail.

Memory: the first judge is unloaded before the second one loads, and the second is unloaded after,
so both are never in RAM together.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone

from app import checks, judge
from app.evidence import KEY_FACTS, KeyFactCheck, claim_id
from app.schemas import Evidence, Explanation, MetricResult, Observation, Run, SecondOpinion

NAMES = {"passed": "supported", "failed": "contradicted", "missing": "not_mentioned"}


@dataclass
class SecondOpinions:
    records: list[SecondOpinion] = field(default_factory=list)
    disputed: set[str] = field(default_factory=set)   # observation ids of claims the judges disagree on
    caveats: list[str] = field(default_factory=list)


@dataclass
class ToRecheck:
    observation_id: str
    evidence: Evidence


def get_second_opinions(
    run: Run,
    results: list[MetricResult],
    key_facts: KeyFactCheck,
    observations: list[Observation],
    explanations: list[Explanation],
) -> SecondOpinions:
    judged = {o.id for o in observations if o.basis == "judged"}
    wanted = judged & {observation_id for e in explanations for observation_id in e.supported_by}
    second_model = judge.pick_second_model()
    if not wanted or not second_model:
        return SecondOpinions()

    # (what was checked, against what, which model, which prompt) -> the claims to re-check
    groups: dict[str, tuple[list[tuple[str, str]], str, str, str, list[ToRecheck]]] = {}
    for result in results:
        if result.judge_model:
            if result.metric_id == "correctness":
                reference = [("answer key", run.expected_output or "")], "answer key"
                version = checks.CORRECTNESS_PROMPT_VERSION
            else:
                reference = checks.sources_for(run), "sources"
                version = checks.GROUNDEDNESS_PROMPT_VERSION
            add(groups, result.metric_id, result.evidence, wanted, reference, result.judge_model, version)
    if key_facts.facts and key_facts.model:
        add(groups, KEY_FACTS, key_facts.facts, wanted, (checks.sources_for(run), "sources"), key_facts.model, checks.GROUNDEDNESS_PROMPT_VERSION)

    opinions = SecondOpinions()
    for (reference, reference_name, original_model, version, items) in groups.values():
        if original_model == second_model:
            opinions.caveats.append(f"No second opinion: the second judge is the same model as the first ({second_model}).")
            continue
        judge.unload(original_model)
        try:
            rechecked, _ = checks.check_claims([item.evidence.item for item in items], reference, second_model, reference_name)
        except judge.JudgeError as error:
            opinions.caveats.append(f"The second opinion from {second_model} couldn't run: {error}.")
            continue
        finally:
            judge.unload(second_model)

        for item, new in zip(items, rechecked, strict=True):
            original, verdict = NAMES[item.evidence.verdict], NAMES[new.verdict]
            opinions.records.append(
                SecondOpinion(
                    claim=item.evidence.item,
                    original_model=original_model,
                    original_verdict=original,
                    model=second_model,
                    verdict=verdict,
                    agreed=original == verdict,
                    prompt_version=version,
                    checked_at=datetime.now(timezone.utc),
                )
            )
            if original == verdict:
                continue
            if "supported" in (original, verdict):
                # One judge says the claim is backed and the other doesn't: the lead can't stand.
                opinions.disputed.add(item.observation_id)
                opinions.caveats.append(
                    f'The judges disagreed on "{item.evidence.item}": {original_model} said {original}, '
                    f"{second_model} said {verdict}. Explanations resting on it were set aside."
                )
            else:
                # Both say it isn't backed; they differ only on whether the sources contradict it or say nothing.
                opinions.caveats.append(
                    f'The judges agree "{item.evidence.item}" isn\'t backed, but not on why: '
                    f"{original_model} said {original}, {second_model} said {verdict}."
                )
    return opinions


def add(groups, metric_id, items, wanted, reference, model, version) -> None:
    for number, evidence in enumerate(items, start=1):
        observation_id = claim_id(metric_id, number)
        if observation_id in wanted and evidence.verdict in NAMES:
            group = groups.setdefault(metric_id, (reference[0], reference[1], model, version, []))
            group[4].append(ToRecheck(observation_id, evidence))
