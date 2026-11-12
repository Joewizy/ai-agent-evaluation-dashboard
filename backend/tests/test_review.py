"""Phase 2: human review, run status, the run list and the "since this morning" summary."""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import judge
from app.main import app
from tests.test_evidence import numbered, verdict

client = TestClient(app)

CLAIM = "The replacement card costs €25."
FEES = "Fee policy: card replacement €10."

passing = {"agent_name": "support-bot", "input": "Card fee?", "output": "Ask a branch.", "latency_ms": 900}
tool_broke = {
    **passing,
    "agent_name": "fees-bot",
    "steps": [{"type": "tool_call", "name": "lookup_fees", "error": "timeout"}],
}
too_slow = {**passing, "latency_ms": 20000}
leaked = {**passing, "agent_name": "mail-bot", "output": "Write to ana.lopez@example.com for help."}  # a person checks leaks


@pytest.fixture(autouse=True)
def use_temp_database(tmp_path, monkeypatch):
    monkeypatch.setenv("EVAL_DB_PATH", str(tmp_path / "test.db"))


def judge_says_contradicted(monkeypatch):
    def ask(prompt, shape, model=None):
        if "claims" in shape["properties"]:
            return {"claims": [CLAIM]}
        return {"verdicts": numbered([verdict(CLAIM, "contradicted", FEES, "The sources say €10.")])}

    monkeypatch.setattr(judge, "ask", ask)


def judge_down(monkeypatch):
    def ask(prompt, shape, model=None):
        raise judge.JudgeError("couldn't reach Ollama")

    monkeypatch.setattr(judge, "ask", ask)


def send(run) -> str:
    return client.post("/runs", json=run).json()["run"]["id"]


def status_of(run_id) -> str:
    return client.get(f"/runs/{run_id}").json()["status"]


def review(run_id, verdict_, metric_id=None, explanation=None, reviewer="sam"):
    body = {"verdict": verdict_, "reviewer": reviewer}
    if metric_id is not None:
        body |= {"target": "metric_result", "metric_id": metric_id}
    else:
        body |= {"target": "explanation", "explanation": explanation}
    return client.post(f"/runs/{run_id}/reviews", json=body)


# ---------- Status ----------


def test_passing_run_is_passed():
    assert status_of(send(passing)) == "passed"


def test_judge_down_is_could_not_run_not_passed(monkeypatch):
    judge_down(monkeypatch)
    run_id = send({**passing, "context": [FEES], "output": CLAIM})
    assert status_of(run_id) == "could_not_run"


def test_failure_needs_review_then_confirmed_then_resolved():
    run_id = send(leaked)
    assert status_of(run_id) == "needs_review"

    assert review(run_id, "inconclusive", metric_id="data_leakage").status_code == 201
    assert status_of(run_id) == "needs_review"  # inconclusive waits for someone else

    assert review(run_id, "correct", metric_id="data_leakage").status_code == 201
    assert status_of(run_id) == "confirmed"

    response = client.post(f"/runs/{run_id}/resolution", json={"action": "Masked emails in replies", "resolved_by": "ana"})
    assert response.status_code == 201
    report = client.get(f"/runs/{run_id}").json()
    assert report["status"] == "resolved"
    assert report["resolution"]["action"] == "Masked emails in replies"
    assert [r["verdict"] for r in report["reviews"]] == ["inconclusive", "correct"]  # every review is kept


def test_every_failure_wrong_is_a_false_alarm():
    run_id = send(leaked)
    review(run_id, "incorrect", metric_id="data_leakage")
    assert status_of(run_id) == "false_alarm"


# ---------- Measured failures (review: auto) ----------


def test_a_measured_failure_is_confirmed_without_a_review():
    """Latency and a recorded step error are measurements (review: auto), so the run is confirmed without a review."""
    for run in (too_slow, tool_broke):
        report = client.get(f"/runs/{send(run)}").json()
        assert report["status"] == "confirmed"
        assert all(r["review"] == "auto" for r in report["results"] if r["passed"] is False)


def test_a_measured_failure_cant_be_reviewed():
    run_id = send(too_slow)
    response = review(run_id, "incorrect", metric_id="latency")
    assert response.status_code == 409 and "measurement" in response.text


def test_a_judged_failure_still_waits_for_a_person_next_to_a_measured_one():
    run_id = send({**leaked, "latency_ms": 20000})
    assert status_of(run_id) == "needs_review"  # the leak is an opinion a person must check
    review(run_id, "incorrect", metric_id="data_leakage")
    assert status_of(run_id) == "confirmed"  # the leak was wrong, but the run was still too slow


def test_one_real_failure_is_enough_to_confirm():
    run_id = send({**leaked, "output": leaked["output"] + " Or call +44 20 7946 0958."})
    review(run_id, "correct", metric_id="data_leakage")
    assert status_of(run_id) == "confirmed"


def test_limits_can_differ_by_agent():
    """Per-agent overrides: football-agent has a 40 s latency limit and the cost metric disabled."""
    slow_local = {**passing, "agent_name": "football-agent", "latency_ms": 22800}
    results = {r["metric_id"]: r for r in client.get(f"/runs/{send(slow_local)}").json()["results"]}
    assert results["latency"]["passed"] is True
    assert "cost" not in results
    other = {r["metric_id"]: r for r in client.get(f"/runs/{send({**slow_local, 'agent_name': 'fees-bot'})}").json()["results"]}
    assert other["latency"]["passed"] is False  # the default limit still applies to every other agent
    assert "cost" in other


def test_reviewing_never_changes_the_result():
    run_id = send(leaked)
    before = client.get(f"/runs/{run_id}").json()
    review(run_id, "incorrect", metric_id="data_leakage")
    after = client.get(f"/runs/{run_id}").json()
    assert after["results"] == before["results"] and after["diagnosis"] == before["diagnosis"]


# ---------- What can't be reviewed or resolved ----------


def test_only_confirmed_failures_can_be_resolved():
    run_id = send(leaked)
    response = client.post(f"/runs/{run_id}/resolution", json={"action": "x", "resolved_by": "ana"})
    assert response.status_code == 409 and "needs_review" in response.text


def test_a_run_is_resolved_once():
    run_id = send(tool_broke)  # measured, so already confirmed
    client.post(f"/runs/{run_id}/resolution", json={"action": "first", "resolved_by": "ana"})
    response = client.post(f"/runs/{run_id}/resolution", json={"action": "second", "resolved_by": "ana"})
    assert response.status_code == 409


def test_bad_review_targets_are_rejected():
    run_id = send(tool_broke)
    assert review(run_id, "correct", metric_id="correctness").status_code == 409  # not run on live runs
    assert review(run_id, "correct", metric_id="cost").status_code == 409  # skipped: no cost sent
    assert review(run_id, "correct", explanation=5).status_code == 409
    assert review(run_id, "correct", explanation=0).status_code == 201  # the tool failure lead
    assert review("no-such-run", "correct", explanation=0).status_code == 404
    bad = client.post(f"/runs/{run_id}/reviews", json={"target": "explanation", "metric_id": "latency", "verdict": "correct", "reviewer": "sam"})
    assert bad.status_code == 422


# ---------- Run list and summary ----------


def test_review_queue_lists_runs_waiting_for_a_person():
    waiting, done, measured, fine = send(leaked), send(leaked), send(tool_broke), send(passing)
    review(done, "correct", metric_id="data_leakage")

    queue = client.get("/runs", params={"status": "needs_review"}).json()
    assert [row["id"] for row in queue] == [waiting]  # the tool failure is measured, so it never queues
    assert queue[0]["failed_metrics"] == ["data_leakage"]
    assert queue[0]["causes"] == ["no_explanation"]
    assert {row["id"] for row in client.get("/runs").json()} == {waiting, done, measured, fine}


def test_since_and_agent_filters():
    send(passing)
    later = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()
    assert client.get("/runs", params={"since": later}).json() == []
    assert len(client.get("/runs", params={"agent": "fees-bot"}).json()) == 0
    assert client.get("/summary", params={"since": later}).json()["runs"] == 0


def test_summary_since_this_morning(monkeypatch):
    send(passing)
    tool_run = send(tool_broke)
    send(too_slow)
    judge_says_contradicted(monkeypatch)
    judged = send({**passing, "context": [FEES], "output": CLAIM})
    judge_down(monkeypatch)
    send({**passing, "context": [FEES], "output": CLAIM})
    send(leaked)

    review(tool_run, "correct", explanation=0)
    review(judged, "incorrect", metric_id="groundedness")
    review(judged, "correct", metric_id="groundedness", reviewer="ana")  # the later review counts
    review(judged, "correct", metric_id="data_leakage")  # passed, code-checked: not a judge review

    summary = client.get("/summary").json()
    assert summary["runs"] == 6
    assert summary["by_status"] == {"passed": 1, "needs_review": 1, "confirmed": 3, "could_not_run": 1}
    assert summary["pending_reviews"] == 1  # only the leak: the tool failure and the slow run are measured
    assert summary["by_agent"]["fees-bot"] == {"runs": 1, "failed": 1, "could_not_run": 0}
    assert summary["by_agent"]["support-bot"] == {"runs": 4, "failed": 2, "could_not_run": 1}
    assert summary["failures_by_cause"] == {"no_explanation": 2, "tool_failure": 1, "answer_contradicts_context": 1}
    assert (summary["failed_runs"], summary["runs_with_several_causes"]) == (4, 0)

    grounded = summary["metrics"]["groundedness"]
    assert grounded["name"] == "Backed by sources"
    assert (grounded["scored"], grounded["failed"], grounded["could_not_run"]) == (1, 1, 1)
    assert grounded["average_score"] == 0.0  # the run that couldn't be checked is left out of the average

    assert summary["judge_vs_humans"] == {"correct": 1, "incorrect": 0, "inconclusive": 0, "agreement": 1.0}
    assert summary["explanations_reviewed"]["correct"] == 1


def test_a_run_with_two_possible_causes_counts_under_both(monkeypatch):
    """The Grok shape: the tool failed and the answer contradicts the sources. Both are leads."""
    judge_says_contradicted(monkeypatch)
    send({**tool_broke, "context": [FEES], "output": CLAIM})
    summary = client.get("/summary").json()
    assert summary["failed_runs"] == 1
    assert summary["runs_with_several_causes"] == 1
    assert set(summary["failures_by_cause"]) == {"tool_failure", "answer_contradicts_context"}


def test_wait_returns_the_full_result_in_one_call():
    response = client.post("/runs", params={"wait": True}, json=tool_broke)
    assert response.status_code == 201
    report = response.json()
    assert report["status"] == "confirmed"  # a recorded step error is measured
    assert report["diagnosis"]["outcome"] == "explanations_found"
    assert report == client.get(f"/runs/{report['run']['id']}").json()


def test_summary_lists_actions_newest_first():
    first, second = send(tool_broke), send(tool_broke)
    for run_id, action in ((first, "Raised the timeout"), (second, "Added a retry")):
        client.post(f"/runs/{run_id}/resolution", json={"action": action, "resolved_by": "ana"})
    actions = client.get("/summary").json()["actions"]
    assert [(a["action"], a["agent_name"], a["run_id"]) for a in actions] == [
        ("Added a retry", "fees-bot", second),
        ("Raised the timeout", "fees-bot", first),
    ]


def test_metrics_say_how_each_is_checked():
    metrics = {m["id"]: m for m in client.get("/metrics").json()}
    assert metrics["groundedness"]["name"] == "Backed by sources"
    assert (metrics["groundedness"]["method"], metrics["groundedness"]["judge_model"]) == ("llm_judge", "qwen3:8b")
    assert (metrics["latency"]["method"], metrics["latency"]["judge_model"]) == ("code", None)
