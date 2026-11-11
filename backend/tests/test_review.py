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
    run_id = send(tool_broke)
    assert status_of(run_id) == "needs_review"

    assert review(run_id, "inconclusive", metric_id="execution_success").status_code == 201
    assert status_of(run_id) == "needs_review"  # inconclusive waits for someone else

    assert review(run_id, "correct", metric_id="execution_success").status_code == 201
    assert status_of(run_id) == "confirmed"

    response = client.post(f"/runs/{run_id}/resolution", json={"action": "Raised the tool timeout", "resolved_by": "ana"})
    assert response.status_code == 201
    report = client.get(f"/runs/{run_id}").json()
    assert report["status"] == "resolved"
    assert report["resolution"]["action"] == "Raised the tool timeout"
    assert [r["verdict"] for r in report["reviews"]] == ["inconclusive", "correct"]  # every review is kept


def test_every_failure_wrong_is_a_false_alarm():
    run_id = send(tool_broke)
    review(run_id, "incorrect", metric_id="execution_success")
    assert status_of(run_id) == "false_alarm"


def test_one_real_failure_out_of_two_is_confirmed():
    run_id = send({**tool_broke, "latency_ms": 20000})
    review(run_id, "incorrect", metric_id="execution_success")
    assert status_of(run_id) == "needs_review"  # speed not checked yet
    review(run_id, "correct", metric_id="latency")
    assert status_of(run_id) == "confirmed"


def test_reviewing_never_changes_the_result():
    run_id = send(tool_broke)
    before = client.get(f"/runs/{run_id}").json()
    review(run_id, "incorrect", metric_id="execution_success")
    after = client.get(f"/runs/{run_id}").json()
    assert after["results"] == before["results"] and after["diagnosis"] == before["diagnosis"]


# ---------- What can't be reviewed or resolved ----------


def test_only_confirmed_failures_can_be_resolved():
    run_id = send(tool_broke)
    response = client.post(f"/runs/{run_id}/resolution", json={"action": "x", "resolved_by": "ana"})
    assert response.status_code == 409 and "needs_review" in response.text


def test_a_run_is_resolved_once():
    run_id = send(tool_broke)
    review(run_id, "correct", metric_id="execution_success")
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
    waiting, done, fine = send(tool_broke), send(tool_broke), send(passing)
    review(done, "correct", metric_id="execution_success")

    queue = client.get("/runs", params={"status": "needs_review"}).json()
    assert [row["id"] for row in queue] == [waiting]
    assert queue[0]["failed_metrics"] == ["execution_success"]
    assert queue[0]["causes"] == ["tool_failure"]
    assert {row["id"] for row in client.get("/runs").json()} == {waiting, done, fine}


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

    review(tool_run, "correct", explanation=0)
    review(judged, "incorrect", metric_id="groundedness")
    review(judged, "correct", metric_id="groundedness", reviewer="ana")  # the later review counts
    review(judged, "correct", metric_id="latency")  # passed, code-checked: not a judge review

    summary = client.get("/summary").json()
    assert summary["runs"] == 5
    assert summary["by_status"] == {"passed": 1, "needs_review": 2, "confirmed": 1, "could_not_run": 1}
    assert summary["pending_reviews"] == 2
    assert summary["by_agent"]["fees-bot"] == {"runs": 1, "failed": 1, "could_not_run": 0}
    assert summary["by_agent"]["support-bot"] == {"runs": 4, "failed": 2, "could_not_run": 1}
    assert summary["failures_by_cause"] == {"tool_failure": 1, "no_explanation": 1, "answer_contradicts_context": 1}
    assert (summary["failed_runs"], summary["runs_with_several_causes"]) == (3, 0)

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
    assert report["status"] == "needs_review"
    assert report["diagnosis"]["outcome"] == "explanations_found"
    assert report == client.get(f"/runs/{report['run']['id']}").json()
