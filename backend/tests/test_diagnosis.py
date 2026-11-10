from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app import judge
from app.diagnose import diagnose
from app.evaluate import evaluate
from app.schemas import Diagnosis, Explanation, Observation, Run

NOW = datetime.now(timezone.utc)

clean_run = {
    "id": "r1",
    "received_at": NOW,
    "agent_name": "support-bot",
    "input": "How much is a replacement card?",
    "output": "It costs €10.",
    "steps": [{"type": "tool_call", "name": "lookup_fees", "output": "€10"}],
    "latency_ms": 1000,
    "cost_usd": 0.002,
}


def diagnosis_for(**changes):
    run = Run(**{**clean_run, **changes})
    return diagnose(run, evaluate(run))


# ---------- Outcome rules ----------


def test_everything_passed_is_not_needed():
    # the fake judge finds no claims, so "Backed by sources" is skipped for missing data. Not a reason to doubt the run
    diagnosis = diagnosis_for()
    assert diagnosis.outcome == "not_needed"
    assert any(caveat.startswith("'groundedness' skipped, missing data") for caveat in diagnosis.caveats)


def test_a_failure_without_explanations_is_insufficient_evidence():
    diagnosis = diagnosis_for(latency_ms=20000)  # too slow, and no rule can say why
    assert diagnosis.outcome == "insufficient_evidence"
    assert diagnosis.explanations == []
    assert [(o.id, o.basis) for o in diagnosis.observations] == [("latency-failed", "computed")]


def test_judge_down_is_not_a_pass(monkeypatch):
    """Skipped isn't passed: nothing failed, but the judge couldn't run, so we can't say all is well."""
    def broken(prompt, shape, model=None):
        raise judge.JudgeError("couldn't reach Ollama")
    monkeypatch.setattr(judge, "ask", broken)

    diagnosis = diagnosis_for(context=["Fee policy: card replacement €10."])
    assert diagnosis.outcome == "insufficient_evidence"
    assert "'groundedness' couldn't run: the judge didn't answer: couldn't reach Ollama." in diagnosis.caveats


def test_judge_returning_nothing_is_insufficient_evidence(monkeypatch):
    """Nothing failed and nothing explains it: the judge answered, but with no verdicts."""
    def empty(prompt, shape, model=None):
        return {"claims": ["It costs €10."]} if "claims" in shape["properties"] else {"verdicts": []}
    monkeypatch.setattr(judge, "ask", empty)

    diagnosis = diagnosis_for(context=["Fee policy: card replacement €10."])
    assert diagnosis.outcome == "insufficient_evidence"
    assert diagnosis.explanations == []
    assert any(caveat.startswith("'groundedness' couldn't run") for caveat in diagnosis.caveats)


def test_metrics_without_their_data_are_skipped_for_missing_data():
    run = Run(**{**clean_run, "cost_usd": None})
    kinds = {result.metric_id: result.skipped_because for result in evaluate(run)}
    assert kinds["cost"] == "missing_data"
    assert kinds["latency"] is None


# ---------- The schema refuses diagnoses that don't hold together ----------


def make(**changes):
    fields = {"run_id": "r1", "outcome": "not_needed", "method": "rules", "version": "test", "diagnosed_at": NOW}
    return Diagnosis(**{**fields, **changes})


step_error = Observation(id="step-error", text="Step 'x' reported an error", basis="recorded")


def test_explanation_must_point_to_real_observations():
    with pytest.raises(ValidationError, match="unknown observation 'nope'"):
        make(
            outcome="explanations_found",
            observations=[step_error],
            explanations=[Explanation(summary="...", supported_by=["nope"])],
        )


def test_observation_ids_must_be_unique():
    with pytest.raises(ValidationError, match="unique"):
        make(observations=[step_error, step_error])


def test_explanations_found_needs_an_explanation():
    with pytest.raises(ValidationError, match="needs at least one explanation"):
        make(outcome="explanations_found")


def test_not_needed_cannot_have_explanations():
    with pytest.raises(ValidationError, match="can't have explanations"):
        make(observations=[step_error], explanations=[Explanation(summary="...", supported_by=["step-error"])])


def test_judged_observation_must_name_its_judge():
    with pytest.raises(ValidationError, match="which judge model"):
        Observation(id="c1", text="The judge found…", basis="judged")
