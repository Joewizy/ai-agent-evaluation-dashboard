from datetime import datetime, timezone

import pytest

from app import judge
from app.checks import matches_answer_key
from app.evaluate import evaluate, load_metrics
from app.schemas import Run

grok_test = {
    "id": "r1",
    "received_at": datetime.now(timezone.utc),
    "agent_name": "grok-bot",
    "mode": "testing",
    "input": "How much is the Grok subscription?",
    "output": "Grok Premium is $15 a month. You can cancel anytime.",
    "expected_output": "Grok Premium is $8 a month. Premium+ is $40 a month.",
}

correctness = next(metric for metric in load_metrics() if metric.id == "correctness")


def fake_judge(monkeypatch, answer_claims, key_claims, answer_verdicts, key_verdicts):
    """Split calls return answer then key claims; check calls return answer then key verdicts."""
    splits = iter([answer_claims, key_claims])
    checks = iter([answer_verdicts, key_verdicts])

    def ask(prompt, shape, model=None):
        if "claims" in shape["properties"]:
            return {"claims": next(splits)}
        return {"verdicts": next(checks)}
    monkeypatch.setattr(judge, "ask", ask)


def verdict(claim, kind, quote="", reason="..."):
    return {"claim": claim, "verdict": kind, "quote": quote, "reason": reason}


def test_wrong_extra_and_left_out(monkeypatch):
    fake_judge(
        monkeypatch,
        answer_claims=["Grok Premium is $15 a month.", "You can cancel anytime."],
        key_claims=["Grok Premium is $8 a month.", "Premium+ is $40 a month."],
        answer_verdicts=[
            verdict("Grok Premium is $15 a month.", "contradicted", "Grok Premium is $8 a month."),
            verdict("You can cancel anytime.", "not_mentioned"),
        ],
        key_verdicts=[
            verdict("Grok Premium is $8 a month.", "contradicted", "Grok Premium is $15 a month."),
            verdict("Premium+ is $40 a month.", "not_mentioned"),
        ],
    )
    outcome = matches_answer_key(Run(**grok_test), correctness)

    assert outcome.score == 0.0  # nothing correct
    assert 'Wrong: "Grok Premium is $15 a month." (the answer key says "Grok Premium is $8 a month.")' in outcome.reason
    assert 'Not in the answer key: "You can cancel anytime."' in outcome.reason
    assert 'Left out: "Premium+ is $40 a month."' in outcome.reason
    assert outcome.judge_prompt_version == "correctness-v1"


def test_partly_right_gives_f1(monkeypatch):
    # 1 correct, 0 wrong, 1 left out → F1 = 2·1 / (2·1 + 0 + 1) = 0.67
    fake_judge(
        monkeypatch,
        answer_claims=["Grok Premium is $8 a month."],
        key_claims=["Grok Premium is $8 a month.", "Premium+ is $40 a month."],
        answer_verdicts=[verdict("Grok Premium is $8 a month.", "supported", "Grok Premium is $8 a month.")],
        key_verdicts=[
            verdict("Grok Premium is $8 a month.", "supported", "Grok Premium is $8 a month."),
            verdict("Premium+ is $40 a month.", "not_mentioned"),
        ],
    )
    outcome = matches_answer_key(Run(**{**grok_test, "output": "Grok Premium is $8 a month."}), correctness)
    assert outcome.score == pytest.approx(2 / 3)
    assert outcome.reason.startswith("1 of 1 claims match the answer key, 1 of 2 key facts covered.")


def test_only_runs_on_testing_runs():
    live_run = Run(**{**grok_test, "mode": "live", "expected_output": None})
    assert "correctness" not in {r.metric_id for r in evaluate(live_run)}
