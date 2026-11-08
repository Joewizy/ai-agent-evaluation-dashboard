import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

card_question = {
    "agent_name": "support-bot",
    "input": "How much is a replacement card?",
    "output": "The replacement card costs €25.",
    "context": ["Fee policy: card replacement €10."],
    "steps": [{"type": "tool_call", "name": "lookup_fees", "output": "€10"}],
    "tokens": 1510,
    "latency_ms": 2100,
}


@pytest.fixture(autouse=True)
def use_temp_database(tmp_path, monkeypatch):
    """Every test gets its own empty database file, so tests don't affect each other."""
    monkeypatch.setenv("EVAL_DB_PATH", str(tmp_path / "test.db"))


def test_send_a_run_and_read_it_back():
    response = client.post("/runs", json=card_question)
    assert response.status_code == 201
    report = response.json()
    assert report["run"]["id"]
    assert report["run"]["mode"] == "live"
    assert {result["metric_id"] for result in report["results"]} == {"cost", "data_leakage", "execution_success", "groundedness", "latency"}

    assert report["diagnosis"]["outcome"] == "not_needed"  # nothing failed; cost and groundedness were skipped for missing data

    response = client.get(f"/runs/{report['run']['id']}")
    assert response.status_code == 200
    assert response.json() == report


def test_testing_run_without_expected_answer_is_rejected():
    response = client.post("/runs", json={**card_question, "mode": "testing"})
    assert response.status_code == 422
    assert "expected_output" in response.text


def test_unknown_run_is_404():
    response = client.get("/runs/does-not-exist")
    assert response.status_code == 404
