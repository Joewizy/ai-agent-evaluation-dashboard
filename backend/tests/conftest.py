import pytest

from app import judge


@pytest.fixture(autouse=True)
def no_real_judge(monkeypatch):
    """Tests never call Ollama. By default the fake judge finds no claims, so groundedness is skipped.
    Tests that need judge answers set their own with fake_judge() in test_groundedness.py."""
    monkeypatch.setattr(judge, "ask", lambda prompt, shape, model=None: {"claims": []})
