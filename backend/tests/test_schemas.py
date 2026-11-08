import pytest
from pydantic import ValidationError

from app.schemas import MetricResult, RunIn

card_question = {
    "agent_name": "support-bot",
    "input": "How much is a replacement card?",
    "output": "The replacement card costs €25.",
    "context": ["Fee policy: card replacement €10."],
    "steps": [{"type": "tool_call", "name": "lookup_fees", "output": "€10"}],
    "tokens": 1510,
    "latency_ms": 2100,
}


def test_live_run_without_expected_answer_is_fine():
    run = RunIn(**card_question)
    assert run.mode == "live"
    assert run.expected_output is None


def test_testing_run_needs_expected_answer():
    with pytest.raises(ValidationError, match="expected_output"):
        RunIn(**card_question, mode="testing")


def test_testing_run_with_expected_answer_is_fine():
    run = RunIn(**card_question, mode="testing", expected_output="€10")
    assert run.expected_output == "€10"


def test_score_must_be_between_0_and_1():
    with pytest.raises(ValidationError):
        MetricResult(
            run_id="r1",
            metric_id="faithfulness",
            score=1.5,
            threshold=0.8,
            passed=True,
            reason="",
            method="llm_judge",
            evaluated_at="2026-11-04T10:00:00Z",
        )
