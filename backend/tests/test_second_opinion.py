"""Selective second opinion (step 6), plus the quote fixes found while comparing judges."""

from app import judge
from app.checks import quote_is_in
from app.judge_checks import quote_problems
from app.schemas import Evidence
from tests.test_evidence import CLAIM, PRICES, by_pattern, diagnosis_for, numbered, verdict

FIRST, SECOND = "qwen3:8b", "gemma3:4b"


def two_judges(monkeypatch, first, second, second_down=False):
    """The first judge gives `first` for the sources check, the second gives `second`. Records unloads."""
    calls = {"unloaded": [], "second_asked": 0}

    def ask(prompt, shape, model=None):
        if "claims" in shape["properties"]:
            return {"claims": [CLAIM]}
        if model == SECOND:
            calls["second_asked"] += 1
            if second_down:
                raise judge.JudgeError("couldn't reach Ollama")
            return {"verdicts": numbered(second)}
        return {"verdicts": numbered(first)}

    monkeypatch.setenv("SECOND_JUDGE_MODEL", SECOND)
    monkeypatch.setattr(judge, "ask", ask)
    monkeypatch.setattr(judge, "unload", lambda model: calls["unloaded"].append(model))
    return calls


CONTRADICTED = verdict(CLAIM, "contradicted", PRICES)


def test_agreement_keeps_the_explanation_and_is_recorded(monkeypatch):
    two_judges(monkeypatch, [CONTRADICTED], [CONTRADICTED])
    diagnosis = diagnosis_for(steps=[])

    assert "answer_contradicts_context" in by_pattern(diagnosis)
    assert diagnosis.method == "rules+judge"
    [record] = diagnosis.second_opinions
    assert (record.claim, record.original_model, record.model, record.agreed) == (CLAIM, FIRST, SECOND, True)
    assert record.original_verdict == record.verdict == "contradicted"
    assert record.prompt_version == "groundedness-v4"


def test_disagreement_sets_the_explanation_aside(monkeypatch):
    two_judges(monkeypatch, [CONTRADICTED], [verdict(CLAIM, "supported", PRICES)])
    diagnosis = diagnosis_for(steps=[])

    assert diagnosis.outcome == "insufficient_evidence"
    assert diagnosis.explanations == []
    assert diagnosis.second_opinions[0].agreed is False
    assert any(c.startswith(f'The judges disagreed on "{CLAIM}": {FIRST} said contradicted, {SECOND} said supported') for c in diagnosis.caveats)


def test_disagreement_keeps_leads_resting_on_other_evidence(monkeypatch):
    """The failed tool is recorded by the agent, not judged, so it stays a lead."""
    two_judges(monkeypatch, [CONTRADICTED], [verdict(CLAIM, "supported", PRICES)])
    diagnosis = diagnosis_for()

    assert diagnosis.outcome == "explanations_found"
    assert list(by_pattern(diagnosis)) == ["tool_failure"]


def test_both_saying_not_backed_keeps_the_lead(monkeypatch):
    """The real football run: qwen3:8b said contradicted, gemma3:4b said not mentioned."""
    two_judges(monkeypatch, [CONTRADICTED], [verdict(CLAIM, "not_mentioned")])
    diagnosis = diagnosis_for(steps=[])

    assert "answer_contradicts_context" in by_pattern(diagnosis)
    assert diagnosis.second_opinions[0].agreed is False  # the record stays exact
    assert any(c.startswith(f'The judges agree "{CLAIM}" isn\'t backed, but not on why') for c in diagnosis.caveats)


def test_second_judge_down_keeps_the_explanation_with_a_caveat(monkeypatch):
    two_judges(monkeypatch, [CONTRADICTED], [], second_down=True)
    diagnosis = diagnosis_for(steps=[])

    assert "answer_contradicts_context" in by_pattern(diagnosis)
    assert diagnosis.second_opinions == []
    assert any(c.startswith(f"The second opinion from {SECOND} couldn't run") for c in diagnosis.caveats)


def test_only_judged_leads_get_a_second_opinion(monkeypatch):
    calls = two_judges(monkeypatch, [], [])
    diagnosis = diagnosis_for(context=[])  # nothing to judge against, so the tool lead rests only on what the agent recorded

    assert list(by_pattern(diagnosis)) == ["tool_failure"]
    assert calls["second_asked"] == 0
    assert diagnosis.second_opinions == []


def test_passing_run_gets_no_second_opinion(monkeypatch):
    calls = two_judges(monkeypatch, [verdict(CLAIM, "supported", CLAIM)], [])
    assert diagnosis_for(steps=[], context=[CLAIM]).outcome == "not_needed"
    assert calls["second_asked"] == 0


def test_only_one_judge_is_in_memory_at_a_time(monkeypatch):
    calls = two_judges(monkeypatch, [CONTRADICTED], [CONTRADICTED])
    diagnosis_for(steps=[])
    assert calls["unloaded"] == [FIRST, SECOND]  # first judge out before the second loads, second out after


def test_turned_off_when_the_setting_is_empty(monkeypatch):
    calls = two_judges(monkeypatch, [CONTRADICTED], [CONTRADICTED])
    monkeypatch.setenv("SECOND_JUDGE_MODEL", "")
    diagnosis = diagnosis_for(steps=[])
    assert calls["second_asked"] == 0 and diagnosis.method == "rules"


# ---------- Quote fixes found while comparing judges on real runs ----------


def test_quote_matching_ignores_reordered_sentences_and_json_punctuation():
    prices = "Pricing page: Grok Premium costs $8 per month. Premium+ costs $40 per month."
    assert quote_is_in("Premium+ costs $40 per month. Grok Premium costs $8 per month.", prices)
    assert quote_is_in('Arsenal: {"position": 2, "points": 42}', '{"Arsenal": {"position": 2, "points": 42}}')
    assert not quote_is_in("Premium costs $8 per year.", prices)
    assert not quote_is_in("Premium+ costs $4 per month.", prices)  # 4 isn't 40


def test_related_word_forms_count_as_the_same_subject():
    item = Evidence(item="You can withdraw as often as you like.", verdict="failed", source="Withdrawals are allowed up to 3 times a year.")
    assert quote_problems(item) == []
