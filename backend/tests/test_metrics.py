from datetime import datetime, timezone

from app.evaluate import evaluate, load_metrics
from app.schemas import Run

card_question = {
    "id": "r1",
    "received_at": datetime.now(timezone.utc),
    "agent_name": "support-bot",
    "input": "How much is a replacement card?",
    "output": "The replacement card costs €25.",
    "context": ["Fee policy: card replacement €10."],
    "steps": [{"type": "tool_call", "name": "lookup_fees", "output": "€10"}],
    "latency_ms": 2100,
}


def results_by_metric(**changes):
    run = Run(**{**card_question, **changes})
    return {result.metric_id: result for result in evaluate(run)}


def test_all_metric_files_load():
    assert {metric.id for metric in load_metrics()} == {"correctness", "cost", "data_leakage", "execution_success", "groundedness", "latency"}


def test_all_steps_worked():
    result = results_by_metric()["execution_success"]
    assert result.score == 1.0
    assert result.passed is True


def test_failed_step_explains_why():
    steps = [
        {"type": "retrieval", "name": "search_policies"},
        {"type": "tool_call", "name": "lookup_fees", "error": "timeout after 5000 ms"},
    ]
    result = results_by_metric(steps=steps)["execution_success"]
    assert result.score == 0.5
    assert result.passed is False
    assert "'lookup_fees' failed: timeout after 5000 ms" in result.reason
    assert [e.verdict for e in result.evidence] == ["passed", "failed"]


def test_no_steps_is_skipped_not_failed():
    result = results_by_metric(steps=[])["execution_success"]
    assert result.score is None
    assert result.passed is None
    assert result.skipped_reason == "the run has no steps"


def test_latency_within_target_is_full_score():
    assert results_by_metric(latency_ms=2100)["latency"].score == 1.0


def test_latency_halfway_to_limit_is_half_score():
    # target 3000, limit 10000: 6500 is halfway
    result = results_by_metric(latency_ms=6500)["latency"]
    assert result.score == 0.5
    assert result.passed is True


def test_latency_over_limit_is_zero():
    result = results_by_metric(latency_ms=12000)["latency"]
    assert result.score == 0.0
    assert result.passed is False


def test_missing_cost_is_skipped():
    result = results_by_metric()["cost"]
    assert result.passed is None
    assert result.skipped_reason == "the run has no cost_usd"


def test_scores_are_rounded_and_reasons_are_plain():
    steps = [
        {"type": "retrieval", "name": "search_pricing_docs"},
        {"type": "tool_call", "name": "get_latest_prices", "error": "could not update"},
        {"type": "llm_call", "name": "write_answer"},
    ]
    results = results_by_metric(steps=steps, latency_ms=6550)
    assert results["execution_success"].score == 0.67
    assert results["latency"].score == 0.49
    assert results["latency"].reason == "Took 6550 ms, over the 3000 ms target (limit 10000 ms)."
