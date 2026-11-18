"""The local fallback when a Gemini judge fails."""

import pytest

from app import judge


def failing_on(bad_model):
    def check(model):
        if model == bad_model:
            raise judge.JudgeError("Gemini returned 503")
        return f"verdicts from {model}"
    return check


@pytest.fixture(autouse=True)
def no_unload(monkeypatch):
    monkeypatch.setattr(judge, "unload", lambda model: None)


def test_gemini_failure_falls_back_to_the_local_model(monkeypatch):
    monkeypatch.setenv("JUDGE_FALLBACK_MODEL", "qwen3:8b")
    assert judge.with_fallback("gemini-3.6-flash", failing_on("gemini-3.6-flash")) == ("verdicts from qwen3:8b", "qwen3:8b")


def test_a_working_judge_is_used_as_is(monkeypatch):
    monkeypatch.setenv("JUDGE_FALLBACK_MODEL", "qwen3:8b")
    assert judge.with_fallback("gemini-3.6-flash", failing_on("none")) == ("verdicts from gemini-3.6-flash", "gemini-3.6-flash")


def test_a_local_judge_failure_is_not_retried(monkeypatch):
    monkeypatch.setenv("JUDGE_FALLBACK_MODEL", "qwen3:8b")
    with pytest.raises(judge.JudgeError):
        judge.with_fallback("llama3.2", failing_on("llama3.2"))


def test_the_fallback_can_be_turned_off(monkeypatch):
    monkeypatch.setenv("JUDGE_FALLBACK_MODEL", "")
    with pytest.raises(judge.JudgeError):
        judge.with_fallback("gemini-3.6-flash", failing_on("gemini-3.6-flash"))


def test_both_failures_are_reported(monkeypatch):
    monkeypatch.setenv("JUDGE_FALLBACK_MODEL", "qwen3:8b")
    def check(model):
        raise judge.JudgeError(f"{model} down")
    with pytest.raises(judge.JudgeError, match="gemini-3.6-flash down; the local fallback qwen3:8b also failed"):
        judge.with_fallback("gemini-3.6-flash", check)
