"""Talking to the AI judge: a local Ollama model, or Google Gemini through its API.

Every judge call goes through ask(). A model whose name starts with "gemini" is sent to Gemini; any other
name is sent to Ollama. On a server without Ollama, set GEMINI_API_KEY and the judges default to Gemini.
"""

import json
import os
import time

import httpx

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models"

DEFAULT_MODEL = "qwen3:8b"
SECOND_MODEL = "gemma3:4b"
GEMINI_DEFAULT_MODEL = "gemini-3.6-flash"
GEMINI_SECOND_MODEL = "gemini-3.5-flash"
GEMINI_RETRY_STATUSES = {429, 500, 503}   # rate limits and temporary overload
GEMINI_ATTEMPTS = 3


def gemini_key() -> str | None:
    return os.environ.get("GEMINI_API_KEY") or None


def is_gemini(model: str) -> bool:
    return model.startswith("gemini")


def pick_model(metric_choice: str | None) -> str:
    """Which judge model to use.

    JUDGE_MODEL wins. Without it, a machine with GEMINI_API_KEY uses Gemini (the metric files name local models),
    and otherwise the metric's YAML choice, then qwen3:8b.
    """
    if os.environ.get("JUDGE_MODEL"):
        return os.environ["JUDGE_MODEL"]
    if gemini_key():
        return GEMINI_DEFAULT_MODEL
    return metric_choice or DEFAULT_MODEL


def pick_second_model() -> str | None:
    """The model that gives a second opinion. SECOND_JUDGE_MODEL wins; set it empty to turn second opinions off."""
    if "SECOND_JUDGE_MODEL" in os.environ:
        return os.environ["SECOND_JUDGE_MODEL"] or None
    return GEMINI_SECOND_MODEL if gemini_key() else SECOND_MODEL


def unload(model: str) -> None:
    """Free a local model's memory now instead of after Ollama's usual 5 minutes. Hosted models need nothing."""
    if is_gemini(model):
        return
    try:
        httpx.post(f"{OLLAMA_URL}/api/generate", json={"model": model, "keep_alive": 0}, timeout=60)
    except httpx.HTTPError:
        pass  # if Ollama is unreachable, nothing is loaded anyway


class JudgeError(Exception):
    """The judge couldn't be reached or gave an answer we couldn't read."""


def ask(prompt: str, answer_shape: dict, model: str = DEFAULT_MODEL) -> dict:
    """Send one prompt and get back JSON in the given shape (a JSON schema)."""
    return ask_gemini(prompt, answer_shape, model) if is_gemini(model) else ask_ollama(prompt, answer_shape, model)


def ask_ollama(prompt: str, answer_shape: dict, model: str) -> dict:
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


def ask_gemini(prompt: str, answer_shape: dict, model: str) -> dict:
    key = gemini_key()
    if not key:
        raise JudgeError(f"GEMINI_API_KEY isn't set, so the judge model '{model}' can't be called")
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json", "responseJsonSchema": answer_shape},
    }
    try:
        for attempt in range(GEMINI_ATTEMPTS):
            response = httpx.post(f"{GEMINI_URL}/{model}:generateContent", timeout=120, headers={"x-goog-api-key": key}, json=body)
            if response.status_code not in GEMINI_RETRY_STATUSES or attempt == GEMINI_ATTEMPTS - 1:
                break
            time.sleep(2**attempt)
        response.raise_for_status()
        parts = response.json()["candidates"][0]["content"]["parts"]
        return json.loads("".join(part.get("text", "") for part in parts))
    except httpx.HTTPStatusError as error:
        raise JudgeError(f"Gemini returned {error.response.status_code}: {error.response.text[:200]}") from error
    except httpx.HTTPError as error:
        raise JudgeError(f"couldn't reach Gemini ({error.__class__.__name__})") from error
    except (KeyError, IndexError, json.JSONDecodeError) as error:
        raise JudgeError(f"couldn't read the judge's answer ({error.__class__.__name__})") from error
