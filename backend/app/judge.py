"""Talking to the AI judge. Ollama on this machine for now.

Every judge call goes through ask(), so swapping in Claude or GPT later means changing only this file.
"""

import json
import os

import httpx

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
DEFAULT_MODEL = "qwen3:8b"
SECOND_MODEL = "gemma3:4b"


def pick_model(metric_choice: str | None) -> str:
    """Which judge model to use. JUDGE_MODEL (set on the machine) wins, then the metric's YAML, then qwen3:8b.

    So someone with a smaller laptop can run JUDGE_MODEL=llama3.2 without editing every metric file.
    """
    return os.environ.get("JUDGE_MODEL") or metric_choice or DEFAULT_MODEL


def pick_second_model() -> str | None:
    """The model that gives a second opinion. SECOND_JUDGE_MODEL wins; set it empty to turn second opinions off."""
    return os.environ.get("SECOND_JUDGE_MODEL", SECOND_MODEL) or None


def unload(model: str) -> None:
    """Free a model's memory now instead of after Ollama's usual 5 minutes, so two judges never sit in RAM together."""
    try:
        httpx.post(f"{OLLAMA_URL}/api/generate", json={"model": model, "keep_alive": 0}, timeout=60)
    except httpx.HTTPError:
        pass  # if Ollama is unreachable, nothing is loaded anyway


class JudgeError(Exception):
    """The judge couldn't be reached or gave an answer we couldn't read."""


def ask(prompt: str, answer_shape: dict, model: str = DEFAULT_MODEL) -> dict:
    """Send one prompt and get back JSON in the given shape (a JSON schema)."""
    try:
        response = httpx.post(
            f"{OLLAMA_URL}/api/chat",
            timeout=300,
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "format": answer_shape,
                "think": False,
                "stream": False,
                "options": {"temperature": 0},
            },
        )
        response.raise_for_status()
        return json.loads(response.json()["message"]["content"])
    except httpx.HTTPStatusError as error:
        raise JudgeError(f"Ollama returned {error.response.status_code}: {error.response.text[:200]}") from error
    except httpx.HTTPError as error:
        raise JudgeError(f"couldn't reach Ollama at {OLLAMA_URL} ({error.__class__.__name__})") from error
    except (KeyError, json.JSONDecodeError) as error:
        raise JudgeError(f"couldn't read the judge's answer ({error.__class__.__name__})") from error
