"""Run DeepEval's faithfulness and answer relevancy on the Grok run, judged by local Ollama.

    cd scripts
    .venv/bin/python compare/deepeval_grok.py            # uses qwen3:8b
    .venv/bin/python compare/deepeval_grok.py llama3.2   # or another Ollama model

What to look for: does it catch "$15" when the context says $8 / $40, and does it say why?
"""

import json
import os
import sys
import time
from pathlib import Path

# DeepEval sends anonymous usage stats (metric names, judge model, counts; not our questions or answers)
# to PostHog unless this is set. Must be set before deepeval is imported.
os.environ.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "YES")

from deepeval.metrics import AnswerRelevancyMetric, FaithfulnessMetric
from deepeval.models import OllamaModel
from deepeval.test_case import LLMTestCase

judge_name = sys.argv[1] if len(sys.argv) > 1 else "qwen3:8b"
run = json.loads((Path(__file__).parent / "grok_run.json").read_text())

judge = OllamaModel(model=judge_name, base_url="http://localhost:11434", temperature=0)
test_case = LLMTestCase(
    input=run["input"],
    actual_output=run["output"],
    retrieval_context=run["context"],
)

for metric in [
    FaithfulnessMetric(model=judge, threshold=1.0, async_mode=False),
    AnswerRelevancyMetric(model=judge, threshold=0.5, async_mode=False),
]:
    started = time.time()
    metric.measure(test_case)
    print(f"\n=== {metric.__class__.__name__} (judge: {judge_name}, {time.time() - started:.0f}s) ===")
    print(f"score:  {metric.score}   passed: {metric.is_successful()}")
    print(f"reason: {metric.reason}")
    for name in ("claims", "truths", "statements", "verdicts"):
        value = getattr(metric, name, None)
        if value:
            print(f"{name}:")
            for item in value:
                print(f"  - {item}")
