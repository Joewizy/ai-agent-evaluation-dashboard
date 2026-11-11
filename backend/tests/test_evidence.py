"""Evidence collection and rule-based explanations, through the real metrics with a fake judge."""

from datetime import datetime, timezone

from app import judge
from app.diagnose import diagnose
from app.evaluate import evaluate
from app.schemas import Run

PRICES = "Grok Premium costs $8 per month."

grok_run = {
    "id": "r1",
    "received_at": datetime.now(timezone.utc),
    "agent_name": "grok-bot",
    "input": "How much is the Grok subscription?",
    "output": "It costs $15 a month.",
    "context": [PRICES],
    "steps": [
        {"type": "tool_call", "name": "get_latest_prices", "error": "the tool could not update"},
        {"type": "llm_call", "name": "write_answer", "output": "It costs $15 a month."},
    ],
    "latency_ms": 1000,
    "cost_usd": 0.002,
}

CLAIM = "It costs $15 a month."
KEY_FACT = "It costs $8 a month."


def verdict(claim, kind, quote="", reason="..."):
    return {"claim": claim, "verdict": kind, "quote": quote, "reason": reason}


def numbered(verdicts):
    return [{**v, "claim_id": number} for number, v in enumerate(verdicts, start=1)]


def fake_judge(monkeypatch, sources=(), answer_key=(), answer=(), key_facts=(), claims=(CLAIM,), key_claims=(KEY_FACT,)):
    """Answers according to what the prompt says it's checking against."""

    def ask(prompt, shape, model=None):
        if "claims" in shape["properties"]:
            return {"claims": list(claims if f"Answer: {CLAIM}" in prompt else key_claims)}
        if "Sources:\n" in prompt:
            checking_key_facts = any(fact in prompt.split("Claims:")[1] for fact in key_claims)
            return {"verdicts": numbered(key_facts if checking_key_facts else sources)}
        if "Answer key:\n" in prompt:
            return {"verdicts": numbered(answer_key)}
        return {"verdicts": numbered(answer)}

    monkeypatch.setattr(judge, "ask", ask)


def diagnosis_for(**changes):
    run = Run(**{**grok_run, **changes})
    return diagnose(run, evaluate(run))


def by_pattern(diagnosis):
    return {explanation.pattern: explanation for explanation in diagnosis.explanations}


def observation(diagnosis, observation_id):
    return next(o for o in diagnosis.observations if o.id == observation_id)


def test_grok_worked_example(monkeypatch):
    """The example from notes/design.md."""
    fake_judge(monkeypatch, sources=[verdict(CLAIM, "contradicted", PRICES)])
    diagnosis = diagnosis_for()

    assert diagnosis.outcome == "explanations_found"
    assert diagnosis.method == "rules"

    error = observation(diagnosis, "step-1-get_latest_prices-error")
    assert error.basis == "recorded"
    assert error.text == "Step 'get_latest_prices' reported an error: the tool could not update"
    assert observation(diagnosis, "step-1-get_latest_prices-answer-step-ran-after").basis == "recorded"

    claim = observation(diagnosis, "groundedness-claim-1")
    assert claim.basis == "judged"
    assert claim.judge_model == "qwen3:8b"
    assert claim.text == f'The judge found the claim "{CLAIM}" contradicted by the sources.'

    quote = observation(diagnosis, "groundedness-claim-1-quote-found")
    assert quote.basis == "computed"
    assert "appears in context 1" in quote.text
    assert quote.refs[1].kind == "context" and quote.refs[1].id == "1"
    assert "supports" not in quote.text  # a quote match is never presented as proof

    patterns = by_pattern(diagnosis)
    assert patterns["answer_contradicts_context"].supported_by == ["groundedness-claim-1", "groundedness-claim-1-quote-found"]
    assert patterns["answer_contradicts_context"].how_to_check == [f'Re-run with the same sources. Does it still say "{CLAIM}"?']

    tool = patterns["tool_failure"]
    assert tool.supported_by == ["step-1-get_latest_prices-error", "step-1-get_latest_prices-answer-step-ran-after"]
    assert tool.weakened_by == ["groundedness-claim-1-quote-found"]  # a price was in the context anyway
    assert tool.who_could_look == "whoever owns 'get_latest_prices'"


def test_made_up_quote_counts_against_the_explanation(monkeypatch):
    fake_judge(monkeypatch, sources=[verdict(CLAIM, "contradicted", "A sentence nobody wrote.")])
    diagnosis = diagnosis_for(steps=[])

    assert observation(diagnosis, "groundedness-claim-1-quote-not-found").basis == "computed"
    explanation = by_pattern(diagnosis)["answer_contradicts_context"]
    assert explanation.supported_by == ["groundedness-claim-1"]
    assert explanation.weakened_by == ["groundedness-claim-1-quote-not-found"]


def test_claim_the_sources_never_mention(monkeypatch):
    fake_judge(monkeypatch, sources=[verdict(CLAIM, "not_mentioned")])
    patterns = by_pattern(diagnosis_for(steps=[]))

    assert list(patterns) == ["claim_not_in_context"]
    assert patterns["claim_not_in_context"].supported_by == ["groundedness-claim-1"]


def test_answer_key_may_be_the_wrong_one(monkeypatch):
    """The sources back the claim and the key contradicts it. We name both and don't pick."""
    fake_judge(
        monkeypatch,
        sources=[verdict(CLAIM, "supported", CLAIM)],
        answer_key=[verdict(CLAIM, "contradicted", KEY_FACT)],
        answer=[verdict(KEY_FACT, "contradicted", CLAIM)],
        key_facts=[verdict(KEY_FACT, "contradicted", CLAIM)],
    )
    diagnosis = diagnosis_for(steps=[], context=[CLAIM], mode="testing", expected_output=KEY_FACT)

    assert diagnosis.outcome == "explanations_found"
    explanation = by_pattern(diagnosis)["context_disagrees_with_answer_key"]
    assert "the answer key may be wrong" in explanation.summary
    assert explanation.supported_by == [
        "groundedness-claim-1",
        "groundedness-claim-1-quote-found",
        "correctness-claim-1",
        "correctness-claim-1-quote-found",
        "key-facts-claim-1",
        "key-facts-claim-1-quote-found",
    ]


def test_left_out_fact_is_not_confused_with_an_extra_claim(monkeypatch):
    fake_judge(
        monkeypatch,
        sources=[verdict(CLAIM, "supported", CLAIM)],
        answer_key=[verdict(CLAIM, "not_mentioned")],
        answer=[verdict(KEY_FACT, "not_mentioned")],
        key_facts=[verdict(KEY_FACT, "not_mentioned")],
    )
    diagnosis = diagnosis_for(steps=[], context=[CLAIM], mode="testing", expected_output=KEY_FACT)

    assert "not mentioned in the answer key" in observation(diagnosis, "correctness-claim-1").text
    assert observation(diagnosis, "correctness-claim-2").text == f'The judge found the answer key\'s fact "{KEY_FACT}" left out of the answer.'


def test_tool_fails_but_the_answer_is_fine(monkeypatch):
    fake_judge(monkeypatch, sources=[verdict(CLAIM, "supported", CLAIM)])
    diagnosis = diagnosis_for(context=[CLAIM])

    assert diagnosis.outcome == "explanations_found"
    assert list(by_pattern(diagnosis)) == ["tool_failure"]
    explanation = diagnosis.explanations[0]
    assert "without affecting the answer" in explanation.summary
    assert "groundedness-claim-1" in explanation.supported_by


def test_judge_down_never_says_the_answer_was_fine(monkeypatch):
    def broken(prompt, shape, model=None):
        raise judge.JudgeError("couldn't reach Ollama")
    monkeypatch.setattr(judge, "ask", broken)

    explanation = by_pattern(diagnosis_for())["tool_failure"]
    assert explanation.summary == "The failed step 'get_latest_prices' may have affected the answer."


def test_passing_run_keeps_its_observations_but_explains_nothing(monkeypatch):
    fake_judge(monkeypatch, sources=[verdict(CLAIM, "supported", CLAIM)])
    diagnosis = diagnosis_for(steps=[], context=[CLAIM])

    assert diagnosis.outcome == "not_needed"
    assert not any(caveat.startswith("Judge check:") for caveat in diagnosis.caveats)
    assert diagnosis.explanations == []
    assert observation(diagnosis, "groundedness-claim-1").basis == "judged"


def test_same_tool_failing_twice_gets_separate_observations(monkeypatch):
    fake_judge(monkeypatch, sources=[verdict(CLAIM, "supported", PRICES)])
    failing = {"type": "tool_call", "name": "get_latest_prices", "error": "timeout"}
    diagnosis = diagnosis_for(steps=[failing, failing])

    ids = [o.id for o in diagnosis.observations]
    assert "step-1-get_latest_prices-error" in ids and "step-2-get_latest_prices-error" in ids
    assert len(diagnosis.explanations) == 2


def test_quote_from_a_tool_result_points_at_the_step(monkeypatch):
    fixture = "Arsenal vs Chelsea, Saturday 3pm"
    fake_judge(monkeypatch, sources=[verdict(CLAIM, "contradicted", fixture)])
    tool = {"type": "tool_call", "name": "get_fixtures", "output": {"fixtures": [fixture, "Spurs vs Leeds"]}}
    diagnosis = diagnosis_for(steps=[tool], context=[])

    quote = observation(diagnosis, "groundedness-claim-1-quote-found")
    assert quote.refs[1].kind == "step" and quote.refs[1].id == "get_fixtures" and quote.refs[1].detail == "step 1"


def test_diagnosis_survives_being_stored_and_read_back(monkeypatch):
    fake_judge(monkeypatch, sources=[verdict(CLAIM, "contradicted", PRICES)])
    diagnosis = diagnosis_for()
    assert type(diagnosis).model_validate_json(diagnosis.model_dump_json()) == diagnosis


# ---------- Step 5: the judge's answers are checked by code ----------


FOOTBALL_CLAIM = "Arsenal play Liverpool on Sunday."


def football_diagnosis(monkeypatch, quote, kind="contradicted", reason="..."):
    fake_judge(monkeypatch, sources=[verdict(FOOTBALL_CLAIM, kind, quote, reason)], claims=[FOOTBALL_CLAIM])
    tool = {"type": "tool_call", "name": "get_fixtures", "output": {"fixtures": ["Arsenal vs Chelsea, Saturday 3pm", "Spurs vs Leeds, Sunday 2pm"]}}
    return diagnosis_for(output=CLAIM, context=[], steps=[tool])


def test_off_topic_quote_counts_against_the_explanation(monkeypatch):
    """The real football run: 'contradicted' was right, but the judge quoted an unrelated fixture."""
    diagnosis = football_diagnosis(monkeypatch, "Spurs vs Leeds, Sunday 2pm")
    explanation = by_pattern(diagnosis)["answer_contradicts_context"]

    assert explanation.supported_by == ["groundedness-claim-1"]  # a found quote no longer backs the judge up
    assert explanation.weakened_by == ["groundedness-claim-1-problem-quote-off-topic"]
    assert any(c.startswith("Judge check:") and "Spurs vs Leeds" in c for c in diagnosis.caveats)


def test_relevant_quote_with_different_values_is_not_flagged(monkeypatch):
    diagnosis = football_diagnosis(monkeypatch, "Arsenal vs Chelsea, Saturday 3pm")
    assert by_pattern(diagnosis)["answer_contradicts_context"].weakened_by == []
    assert not any(c.startswith("Judge check:") for c in diagnosis.caveats)


def test_supported_quote_missing_the_claims_number_is_flagged(monkeypatch):
    fake_judge(monkeypatch, sources=[verdict(CLAIM, "supported", PRICES)])
    diagnosis = diagnosis_for(steps=[])
    assert "groundedness-claim-1-problem-quote-missing-number" in {o.id for o in diagnosis.observations}
    assert any("15" in c and c.startswith("Judge check:") for c in diagnosis.caveats)


def test_suspect_support_stops_us_saying_a_failed_tool_did_no_harm(monkeypatch):
    fake_judge(monkeypatch, sources=[verdict(CLAIM, "supported", PRICES)])
    assert diagnosis_for().explanations[0].summary == "The failed step 'get_latest_prices' may have affected the answer."


def test_verdict_without_a_quote_is_flagged(monkeypatch):
    fake_judge(monkeypatch, sources=[verdict(CLAIM, "contradicted")])
    assert by_pattern(diagnosis_for(steps=[]))["answer_contradicts_context"].weakened_by == ["groundedness-claim-1-problem-no-quote"]


def test_not_mentioned_with_a_quote_is_flagged(monkeypatch):
    fake_judge(monkeypatch, sources=[verdict(CLAIM, "not_mentioned", PRICES)])
    assert "groundedness-claim-1-problem-quote-on-not-mentioned" in by_pattern(diagnosis_for(steps=[]))["claim_not_in_context"].weakened_by


def test_reason_that_disagrees_with_the_verdict_is_flagged(monkeypatch):
    """The llama3.2 case from notes/research.md."""
    fake_judge(monkeypatch, sources=[verdict(CLAIM, "contradicted", PRICES, "There are no contradictions in the answer.")])
    assert by_pattern(diagnosis_for(steps=[]))["answer_contradicts_context"].weakened_by == ["groundedness-claim-1-problem-reason-disagrees"]


def test_normal_contradiction_reason_is_not_flagged(monkeypatch):
    fake_judge(monkeypatch, sources=[verdict(CLAIM, "contradicted", PRICES, "The sources don't mention $15, they say $8.")])
    assert by_pattern(diagnosis_for(steps=[]))["answer_contradicts_context"].weakened_by == []


# ---------- Fact missing from the sources (testing runs) ----------


def key_fact_run(monkeypatch, key_facts):
    fake_judge(
        monkeypatch,
        sources=[verdict(CLAIM, "supported", CLAIM)],
        answer_key=[verdict(CLAIM, "not_mentioned")],
        answer=[verdict(KEY_FACT, "not_mentioned")],
        key_facts=key_facts,
    )
    return diagnosis_for(steps=[], context=[CLAIM], mode="testing", expected_output=KEY_FACT)


def test_key_fact_not_in_the_sources(monkeypatch):
    diagnosis = key_fact_run(monkeypatch, [verdict(KEY_FACT, "not_mentioned")])
    explanation = by_pattern(diagnosis)["fact_missing_from_context"]

    assert explanation.supported_by == ["key-facts-claim-1"]
    assert "could point to search, the documents, or the question" in explanation.summary
    assert observation(diagnosis, "key-facts-claim-1").text == f'The judge found the answer key\'s fact "{KEY_FACT}" not mentioned in the sources.'
    assert diagnosis.method == "rules+judge"


def test_key_fact_that_is_in_the_sources_is_not_called_missing(monkeypatch):
    diagnosis = key_fact_run(monkeypatch, [verdict(KEY_FACT, "supported", CLAIM)])
    assert "fact_missing_from_context" not in by_pattern(diagnosis)


def test_judge_failing_on_key_facts_is_a_caveat_not_a_crash(monkeypatch):
    diagnosis = key_fact_run(monkeypatch, [])  # no verdicts come back
    assert "fact_missing_from_context" not in by_pattern(diagnosis)
    assert diagnosis.method == "rules"
    assert any(c.startswith("Couldn't check whether the answer key's facts") for c in diagnosis.caveats)


def test_key_facts_are_only_checked_when_correct_answer_failed(monkeypatch):
    fake_judge(
        monkeypatch,
        sources=[verdict(CLAIM, "supported", CLAIM)],
        answer_key=[verdict(CLAIM, "supported", CLAIM)],
        answer=[verdict(CLAIM, "supported", CLAIM)],
        key_facts=[verdict(CLAIM, "supported", CLAIM)],  # key fact and claim are the same text here, so the fake routes on this
        key_claims=[CLAIM],
    )
    diagnosis = diagnosis_for(steps=[], context=[CLAIM], mode="testing", expected_output=CLAIM)
    assert diagnosis.outcome == "not_needed" and diagnosis.method == "rules"


# ---------- Found by the hand-checked cases (backend/hand_checked) ----------


def test_quote_matching_ignores_reordered_sentences_and_json_punctuation():
    from app.checks import quote_is_in
    prices = "Pricing page: Grok Premium costs $8 per month. Premium+ costs $40 per month."
    assert quote_is_in("Premium+ costs $40 per month. Grok Premium costs $8 per month.", prices)
    assert quote_is_in('Arsenal: {"position": 2, "points": 42}', '{"Arsenal": {"position": 2, "points": 42}}')
    assert not quote_is_in("Premium costs $8 per year.", prices)
    assert not quote_is_in("Premium+ costs $4 per month.", prices)  # 4 isn't 40


def test_related_word_forms_count_as_the_same_subject():
    from app.judge_checks import quote_problems
    from app.schemas import Evidence
    item = Evidence(item="You can withdraw as often as you like.", verdict="failed", source="Withdrawals are allowed up to 3 times a year.")
    assert quote_problems(item) == []
