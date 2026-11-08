from datetime import datetime, timezone

import pytest

from app import judge
from app.checks import claims_supported
from app.evaluate import load_metrics
from app.schemas import Run

grok_run = {
    "id": "r1",
    "received_at": datetime.now(timezone.utc),
    "agent_name": "grok-bot",
    "input": "How much is the Grok subscription?",
    "output": "The Grok subscription is $15 a month. Premium+ is $40 a month. You can cancel anytime.",
    "context": ["Pricing page: Grok Premium costs $8 per month. Premium+ costs $40 per month."],
    "steps": [{"type": "tool_call", "name": "get_latest_prices", "error": "could not update"}],
}

groundedness = next(metric for metric in load_metrics() if metric.id == "groundedness")


def fake_judge(monkeypatch, claims, verdicts):
    """Answer the first judge call with claims and the second with verdicts."""
    def ask(prompt, shape, model=None):
        return {"claims": claims} if "claims" in shape["properties"] else {"verdicts": verdicts}
    monkeypatch.setattr(judge, "ask", ask)


def verdict(claim, kind, quote="", reason="..."):
    return {"claim": claim, "verdict": kind, "quote": quote, "reason": reason}


def test_wrong_price_explains_why(monkeypatch):
    fake_judge(
        monkeypatch,
        claims=["The Grok subscription is $15 a month.", "Premium+ is $40 a month.", "You can cancel anytime."],
        verdicts=[
            verdict("The Grok subscription is $15 a month.", "contradicted", "Grok Premium costs $8 per month."),
            verdict("Premium+ is $40 a month.", "supported", "Premium+ costs $40 per month."),
            verdict("You can cancel anytime.", "not_mentioned"),
        ],
    )
    outcome = claims_supported(Run(**grok_run), groundedness)

    assert outcome.score == pytest.approx(1 / 3)
    assert [e.verdict for e in outcome.evidence] == ["failed", "passed", "missing"]
    assert 'Contradicted: "The Grok subscription is $15 a month." (the sources say "Grok Premium costs $8 per month.")' in outcome.reason
    assert 'Not in the sources: "You can cancel anytime."' in outcome.reason
    assert "get_latest_prices" not in outcome.reason  # linking failed steps to wrong claims is diagnosis's job
    assert outcome.judge_model == "qwen3:8b"
    assert outcome.judge_prompt_version == "groundedness-v2"


def test_all_claims_backed(monkeypatch):
    fake_judge(
        monkeypatch,
        claims=["Premium+ is $40 a month."],
        verdicts=[verdict("Premium+ is $40 a month.", "supported", "Premium+ costs $40 per month.")],
    )
    outcome = claims_supported(Run(**grok_run), groundedness)
    assert outcome.score == 1.0
    assert outcome.reason == "All 1 claims are backed by the sources."


def test_made_up_quote_is_flagged(monkeypatch):
    fake_judge(
        monkeypatch,
        claims=["Premium+ is $40 a month."],
        verdicts=[verdict("Premium+ is $40 a month.", "supported", "Premium+ is on sale for $40.")],
    )
    outcome = claims_supported(Run(**grok_run), groundedness)
    assert "the judge's quote isn't in the text it was checking against" in outcome.evidence[0].note
    assert "treat this result with care" in outcome.reason


def test_no_context_is_skipped():
    outcome = claims_supported(Run(**{**grok_run, "context": []}), groundedness)
    assert outcome.score is None
    assert outcome.skipped_reason == "the run has no context to check the answer against"


def test_judge_down_is_skipped_not_failed(monkeypatch):
    def broken(prompt, shape, model=None):
        raise judge.JudgeError("couldn't reach Ollama at http://localhost:11434 (ConnectError)")
    monkeypatch.setattr(judge, "ask", broken)

    outcome = claims_supported(Run(**grok_run), groundedness)
    assert outcome.score is None
    assert "the judge didn't answer: couldn't reach Ollama" in outcome.skipped_reason


def test_judge_model_setting_on_the_machine_wins(monkeypatch):
    monkeypatch.setenv("JUDGE_MODEL", "llama3.2")
    fake_judge(
        monkeypatch,
        claims=["Premium+ is $40 a month."],
        verdicts=[verdict("Premium+ is $40 a month.", "supported", "Premium+ costs $40 per month.")],
    )
    assert claims_supported(Run(**grok_run), groundedness).judge_model == "llama3.2"
