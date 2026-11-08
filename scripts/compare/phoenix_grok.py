"""Send the Grok run to Arize Phoenix as a trace, then grade it with Phoenix's faithfulness evaluator.

First start Phoenix in another terminal (it's a local dashboard at http://localhost:6006):

    cd scripts
    PHOENIX_TELEMETRY_ENABLED=false .venv/bin/phoenix serve

(PHOENIX_TELEMETRY_ENABLED=false turns off the analytics Phoenix loads in its web page by default.
Phoenix itself runs on your machine and stores traces in ~/.phoenix.)

Then:

    .venv/bin/python compare/phoenix_grok.py            # uses qwen3:8b
    .venv/bin/python compare/phoenix_grok.py llama3.2   # or another Ollama model

Open http://localhost:6006, project "grok-bot", click the trace.
What to look for: how it shows the steps, the failed tool, and the faithfulness score and explanation.
"""

import json
import sys
import time
from pathlib import Path

from openinference.semconv.trace import OpenInferenceSpanKindValues as Kind
from openinference.semconv.trace import SpanAttributes as Attr
from opentelemetry.trace import Status, StatusCode
from phoenix.client import Client
from phoenix.evals import LLM
from phoenix.evals.metrics.faithfulness import FaithfulnessEvaluator
from phoenix.otel import register

PHOENIX = "http://localhost:6006"
judge_name = sys.argv[1] if len(sys.argv) > 1 else "qwen3:8b"
run = json.loads((Path(__file__).parent / "grok_run.json").read_text())

# ---------- 1. Send the run as a trace (one span for the run, one per step) ----------

tracer_provider = register(
    project_name=run["agent_name"],
    endpoint=f"{PHOENIX}/v1/traces",
    set_global_tracer_provider=False,  # so the judge's own calls don't show up inside the agent's trace
    verbose=False,
)
tracer = tracer_provider.get_tracer("grok-run")

span_kinds = {"retrieval": Kind.RETRIEVER, "tool_call": Kind.TOOL, "llm_call": Kind.LLM}

with tracer.start_as_current_span("grok-bot run") as run_span:
    run_span.set_attribute(Attr.OPENINFERENCE_SPAN_KIND, Kind.AGENT.value)
    run_span.set_attribute(Attr.INPUT_VALUE, run["input"])
    run_span.set_attribute(Attr.OUTPUT_VALUE, run["output"])

    for step in run["steps"]:
        with tracer.start_as_current_span(step["name"]) as step_span:
            step_span.set_attribute(Attr.OPENINFERENCE_SPAN_KIND, span_kinds[step["type"]].value)
            step_span.set_attribute(Attr.INPUT_VALUE, json.dumps(step.get("input")))
            if step.get("output"):
                step_span.set_attribute(Attr.OUTPUT_VALUE, step["output"])
            if step["type"] == "retrieval":
                for i, document in enumerate(run["context"]):
                    step_span.set_attribute(f"{Attr.RETRIEVAL_DOCUMENTS}.{i}.document.content", document)
            if step["type"] == "llm_call":
                step_span.set_attribute(Attr.LLM_MODEL_NAME, run["model"])
                step_span.set_attribute(Attr.LLM_TOKEN_COUNT_TOTAL, run["tokens"])
            if step.get("error"):
                step_span.set_status(Status(StatusCode.ERROR, step["error"]))

    run_span_id = format(run_span.get_span_context().span_id, "016x")

tracer_provider.force_flush()
print(f"Sent trace. Run span id: {run_span_id}")

# ---------- 2. Grade it with Phoenix's faithfulness evaluator, judged by local Ollama ----------

judge = LLM(
    provider="openai",
    model=judge_name,
    sync_client_kwargs={"base_url": "http://localhost:11434/v1", "api_key": "ollama"},
    async_client_kwargs={"base_url": "http://localhost:11434/v1", "api_key": "ollama"},
)
evaluator = FaithfulnessEvaluator(llm=judge, temperature=0)

started = time.time()
[score] = evaluator.evaluate({"input": run["input"], "output": run["output"], "context": "\n".join(run["context"])})
print(f"\n=== Phoenix faithfulness (judge: {judge_name}, {time.time() - started:.0f}s) ===")
print(f"label:       {score.label}")
print(f"score:       {score.score}")
print(f"explanation: {score.explanation}")

# ---------- 3. Attach the score to the trace so it shows in the Phoenix UI ----------

time.sleep(2)  # give Phoenix a moment to store the trace
Client(base_url=PHOENIX).spans.add_span_annotation(
    span_id=run_span_id,
    annotation_name="faithfulness",
    annotator_kind="LLM",
    label=score.label,
    score=score.score,
    explanation=score.explanation,
    sync=True,
)
print(f"\nOpen {PHOENIX} → project '{run['agent_name']}' → the trace, to see it.")
