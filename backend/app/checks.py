"""The Python behind each kind of check.

A metric's YAML file names one of these in its `check` field. Several metrics can share a check
with different settings (latency and cost both use `within_limit`).

Every check returns an Outcome: a score from 0 to 1 and a reason a person can read,
or a skipped_reason if the run doesn't have what the check needs.
"""

import json
import re
from dataclasses import dataclass, field

from app import judge, personal_data
from app.schemas import Evidence, Metric, Run, Step


@dataclass
class Outcome:
    score: float | None = None
    reason: str = ""
    evidence: list[Evidence] = field(default_factory=list)
    skipped_reason: str | None = None
    could_not_run: bool = False   # True if our evaluation broke, rather than the run lacking data
    judge_model: str | None = None
    judge_prompt_version: str | None = None


def steps_succeeded(run: Run, metric: Metric) -> Outcome:
    """execution success = steps without errors ÷ total steps"""
    if not run.steps:
        return Outcome(skipped_reason="the run has no steps")

    evidence = [
        Evidence(
            item=step.name,
            verdict="failed" if step.error else "passed",
            note=step.error,
        )
        for step in run.steps
    ]
    failed = [step for step in run.steps if step.error]
    score = (len(run.steps) - len(failed)) / len(run.steps)

    if failed:
        details = "; ".join(f"'{step.name}' failed: {step.error}" for step in failed)
        reason = f"{len(failed)} of {len(run.steps)} steps failed. {details}"
    else:
        reason = f"All {len(run.steps)} steps worked."
    return Outcome(score=score, reason=reason, evidence=evidence)


def within_limit(run: Run, metric: Metric) -> Outcome:
    """1 up to the target, 0 at the limit, a straight line in between.

    Settings: field (which run field to read), target, limit, unit, label (how the reason starts).
    """
    field_name = metric.settings["field"]
    target = metric.settings["target"]
    limit = metric.settings["limit"]
    unit = metric.settings.get("unit", "")
    label = metric.settings.get("label", field_name)

    value = getattr(run, field_name)
    if value is None:
        return Outcome(skipped_reason=f"the run has no {field_name}")

    if value <= target:
        score = 1.0
        reason = f"{label} {value} {unit}, within the {target} {unit} target."
    elif value >= limit:
        score = 0.0
        reason = f"{label} {value} {unit}, over the {limit} {unit} limit."
    else:
        score = (limit - value) / (limit - target)
        reason = f"{label} {value} {unit}, over the {target} {unit} target (limit {limit} {unit})."
    return Outcome(score=score, reason=reason)


def no_personal_data(run: Run, metric: Metric) -> Outcome:
    """1 if the answer contains none of the listed kinds of personal data, else 0.

    Settings: kinds (which to look for). Matches are stored masked, never in full.
    """
    kinds = metric.settings.get("kinds", list(personal_data.FINDERS))
    found = personal_data.find_personal_data(run.output, kinds)
    if not found:
        return Outcome(score=1.0, reason="No personal data found in the answer.")

    evidence = [Evidence(item=f.masked, verdict="failed", note=f.kind) for f in found]
    listed = ", ".join(f.masked for f in found)
    reason = f"Found {len(found)} piece(s) of personal data in the answer: {listed}."
    return Outcome(score=0.0, reason=reason, evidence=evidence)


# ---------- Checks that use the AI judge ----------

SPLIT_PROMPT = """Split the answer into short, standalone factual claims. Keep numbers and names exactly as written. Don't add anything that isn't in the answer.

Answer: {answer}"""

CHECK_PROMPT = """For each numbered claim, decide if the {reference_name} supports it. Use only the {reference_name}, not your own knowledge. Give exactly one verdict per claim and put the claim's number in "claim_id".
- "supported": the {reference_name} states it or clearly implies it.
- "contradicted": the {reference_name} says something different.
- "not_mentioned": the {reference_name} says nothing about it.
For "supported" and "contradicted", copy the sentence from the {reference_name} that supports or contradicts the claim, word for word, into "quote". For "not_mentioned", leave "quote" empty.
Give a one-sentence reason.

{reference_title}:
{context}

Claims:
{claims}"""

CLAIMS_SHAPE = {
    "type": "object",
    "properties": {"claims": {"type": "array", "items": {"type": "string"}}},
    "required": ["claims"],
}

VERDICTS_SHAPE = {
    "type": "object",
    "properties": {
        "verdicts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "claim_id": {"type": "integer"},
                    "verdict": {"type": "string", "enum": ["supported", "contradicted", "not_mentioned"]},
                    "quote": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["claim_id", "verdict", "quote", "reason"],
            },
        }
    },
    "required": ["verdicts"],
}

GROUNDEDNESS_PROMPT_VERSION = "groundedness-v4"   # v4: the judge answers by claim number


def simplify(text: str) -> str:
    """Lowercase and drop extra spaces and outer punctuation, so a quote can be compared with a text."""
    return " ".join(text.lower().split()).strip(" .\"'")


# The labels we put in front of each text in the prompt. The judge sometimes copies one into its quote.
SOURCE_LABEL = re.compile(r"^\s*\[(context \d+|tool call '[^']*'|retrieval '[^']*'|answer key|answer)\]", re.IGNORECASE)


def words_only(text: str) -> str:
    """Lowercase words, numbers and currency signs, one space apart. Punctuation and JSON quoting drop out."""
    return " ".join(re.findall(r"[^\W_]+|[%€$£+]", text.lower()))


def quote_is_in(quote: str, text: str) -> bool:
    """Does the judge's quote appear in this text?

    Each sentence of the quote must appear word for word, ignoring case, punctuation and any label it
    copied. Sentences may come in any order, since judges often quote two sentences the other way round.
    """
    sentences = [words_only(sentence) for sentence in re.split(r"(?<=[.!?])\s+", SOURCE_LABEL.sub(" ", quote))]
    sentences = [sentence for sentence in sentences if sentence]
    target = f" {words_only(text)} "
    return bool(sentences) and all(f" {sentence} " in target for sentence in sentences)


def split_claims(text: str, model: str) -> list[str]:
    """Ask the judge to split a text into short factual claims."""
    return judge.ask(SPLIT_PROMPT.format(answer=text), CLAIMS_SHAPE, model)["claims"]


def tool_results(run: Run) -> list[tuple[int, Step, str]]:
    """(position in the run, step, output as text) for every retrieval and tool_call step that worked."""
    results = []
    for position, step in enumerate(run.steps, start=1):
        if step.type in ("retrieval", "tool_call") and step.output is not None and not step.error:
            text = step.output if isinstance(step.output, str) else json.dumps(step.output, ensure_ascii=False)
            results.append((position, step, text))
    return results


def sources_for(run: Run) -> list[tuple[str, str]]:
    """Everything the agent looked up before answering, as (label, text) pairs.

    - every item in `context` (documents the agent sends explicitly)
    - the output of every retrieval and tool_call step that worked (e.g. what an API like lookup_fees returned)

    Not included: llm_call outputs (the agent's own writing), output from failed steps, and exact duplicates.
    """
    sources = [(f"context {number}", text) for number, text in enumerate(run.context, start=1)]
    for _, step, text in tool_results(run):
        sources.append((f"{step.type.replace('_', ' ')} '{step.name}'", text))

    seen, unique = set(), []
    for label, text in sources:
        if text.strip() and text not in seen:
            seen.add(text)
            unique.append((label, text))
    return unique


def check_claims(
    claims: list[str], reference: list[tuple[str, str]], model: str, reference_name: str = "sources"
) -> tuple[list[Evidence], int]:
    """Ask the judge to check each claim against the reference texts, given as (label, text) pairs.

    reference_name tells the judge what it's reading ("sources", "answer key", "answer"),
    so its reasons name the right thing.

    The judge answers by claim number and our code fills in the claim's text, so it can't reword a claim.
    A claim with no verdict, or a verdict for a claim we didn't ask about, means we can't trust the count,
    so it raises JudgeError and the metric is skipped as could_not_run.

    Returns one Evidence per claim, in order (passed = supported, failed = contradicted, missing = not mentioned),
    and how many of the judge's quotes we couldn't find in the reference.
    """
    labelled = "\n".join(f"[{label}] {text}" for label, text in reference)
    verdicts = judge.ask(
        CHECK_PROMPT.format(
            reference_name=reference_name,
            reference_title=reference_name.capitalize(),
            context=labelled,
            claims="\n".join(f"{number}. {claim}" for number, claim in enumerate(claims, start=1)),
        ),
        VERDICTS_SHAPE,
        model,
    )["verdicts"]

    ids = [verdict["claim_id"] for verdict in verdicts]
    if len(ids) != len(claims) or set(ids) != set(range(1, len(claims) + 1)):
        raise judge.JudgeError(f"it answered for claims {ids} when asked about claims 1 to {len(claims)}")

    evidence = []
    made_up_quotes = 0
    for verdict in sorted(verdicts, key=lambda v: v["claim_id"]):
        quote = verdict["quote"].strip()
        note = verdict["reason"]
        if quote and not any(quote_is_in(quote, text) for _, text in reference):
            made_up_quotes += 1
            note += " (Warning: the judge's quote isn't in the text it was checking against.)"
        evidence.append(
            Evidence(
                item=claims[verdict["claim_id"] - 1],
                verdict={"supported": "passed", "contradicted": "failed", "not_mentioned": "missing"}[verdict["verdict"]],
                source=quote or None,
                note=note,
            )
        )
    return evidence, made_up_quotes


def claims_supported(run: Run, metric: Metric) -> Outcome:
    """groundedness = claims backed by the sources ÷ total claims (RAGAS faithfulness).

    Sources = context plus tool and retrieval results (see sources_for).
    1. The judge splits the answer into claims.
    2. The judge checks each claim against the sources: supported, contradicted or not mentioned,
       quoting the sentence it used.
    3. We check each quote really is in the sources, so the judge can't make up a source.
    """
    sources = sources_for(run)
    if not sources:
        return Outcome(skipped_reason="the run has no sources to check the answer against (no context or tool results)")

    model = judge.pick_model(metric.settings.get("judge_model"))
    try:
        claims = split_claims(run.output, model)
        if not claims:
            return Outcome(skipped_reason="the answer has no factual claims to check")
        evidence, made_up_quotes = check_claims(claims, sources, model)
    except judge.JudgeError as error:
        return Outcome(skipped_reason=f"the judge didn't answer: {error}", could_not_run=True)

    backed = [e for e in evidence if e.verdict == "passed"]
    contradicted = [e for e in evidence if e.verdict == "failed"]
    not_mentioned = [e for e in evidence if e.verdict == "missing"]
    score = len(backed) / len(evidence) if evidence else 0.0

    if not contradicted and not not_mentioned:
        reason = f"All {len(evidence)} claims are backed by the sources."
    else:
        parts = [f"{len(contradicted) + len(not_mentioned)} of {len(evidence)} claims aren't backed by the sources."]
        for e in contradicted:
            parts.append(f'Contradicted: "{e.item}" (the sources say "{e.source}").')
        for e in not_mentioned:
            parts.append(f'Not in the sources: "{e.item}".')
        reason = " ".join(parts)
    if made_up_quotes:
        reason += f" Judge check: {made_up_quotes} quote(s) from the judge aren't in the sources, so treat this result with care."

    return Outcome(
        score=score,
        reason=reason,
        evidence=evidence,
        judge_model=model,
        judge_prompt_version=GROUNDEDNESS_PROMPT_VERSION,
    )


CORRECTNESS_PROMPT_VERSION = "correctness-v2"   # v2: the judge answers by claim number


def matches_answer_key(run: Run, metric: Metric) -> Outcome:
    """correctness = F1 of the answer's claims against the answer key (RAGAS factual correctness).

    TP = answer claims the answer key supports
    FP = answer claims the answer key contradicts or doesn't mention   (wrong or extra)
    FN = answer key claims the answer doesn't cover                     (left out)
    F1 = 2·TP ÷ (2·TP + FP + FN)
    """
    if not run.expected_output:
        return Outcome(skipped_reason="the run has no expected answer")

    model = judge.pick_model(metric.settings.get("judge_model"))
    try:
        answer_claims = split_claims(run.output, model)
        key_claims = split_claims(run.expected_output, model)
        if not answer_claims and not key_claims:
            return Outcome(skipped_reason="neither the answer nor the answer key has factual claims")
        answer_checked, made_up_quotes = (
            check_claims(answer_claims, [("answer key", run.expected_output)], model, "answer key") if answer_claims else ([], 0)
        )
        key_checked, _ = check_claims(key_claims, [("answer", run.output)], model, "answer") if key_claims else ([], 0)
    except judge.JudgeError as error:
        return Outcome(skipped_reason=f"the judge didn't answer: {error}", could_not_run=True)

    correct = [e for e in answer_checked if e.verdict == "passed"]
    wrong = [e for e in answer_checked if e.verdict == "failed"]
    extra = [e for e in answer_checked if e.verdict == "missing"]
    not_covered = [e for e in key_checked if e.verdict != "passed"]   # counts towards FN, as in RAGAS
    left_out = [e for e in key_checked if e.verdict == "missing"]     # the answer says nothing about it
    # Key facts the answer contradicts are already explained by a "Wrong" claim, so they aren't listed as left out.

    tp, fp, fn = len(correct), len(wrong) + len(extra), len(not_covered)
    score = 2 * tp / (2 * tp + fp + fn) if tp else 0.0

    key_fact_evidence = [
        Evidence(item=e.item, verdict="left_out", note=f"In the answer key but left out of the answer. {e.note}")
        for e in left_out
    ] + [
        Evidence(item=e.item, verdict="key_contradicted", note=f"In the answer key, but the answer says otherwise. {e.note}")
        for e in key_checked
        if e.verdict == "failed"
    ]

    if not wrong and not extra and not not_covered:
        reason = f"Matches the answer key: all {len(answer_checked)} claims are correct and nothing was left out."
    else:
        parts = [f"{tp} of {len(answer_checked)} claims match the answer key, {len(key_checked) - fn} of {len(key_checked)} key facts covered."]
        for e in wrong:
            parts.append(f'Wrong: "{e.item}" (the answer key says "{e.source}").')
        for e in extra:
            parts.append(f'Not in the answer key: "{e.item}".')
        for e in left_out:
            parts.append(f'Left out: "{e.item}".')
        reason = " ".join(parts)
    if made_up_quotes:
        reason += f" Judge check: {made_up_quotes} quote(s) from the judge aren't in the answer key, so treat this result with care."

    return Outcome(
        score=score,
        reason=reason,
        evidence=answer_checked + key_fact_evidence,
        judge_model=model,
        judge_prompt_version=CORRECTNESS_PROMPT_VERSION,
    )


CHECKS = {
    "steps_succeeded": steps_succeeded,
    "within_limit": within_limit,
    "no_personal_data": no_personal_data,
    "claims_supported": claims_supported,
    "matches_answer_key": matches_answer_key,
}
