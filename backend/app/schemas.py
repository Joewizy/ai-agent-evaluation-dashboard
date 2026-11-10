"""The shapes of the data the backend works with.

Three main things:
  Run           - what the agent did (sent to us by the agent)
  Metric        - a question we ask about every run
  MetricResult  - one metric's answer for one run, with the reason

FastAPI uses these to check incoming requests and to build the API docs at /docs.
"""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

# ---------- Run ----------

RunMode = Literal["testing", "live"]
"""testing = we know the correct answer. live = a real request with no known answer."""


class Step(BaseModel):
    """One thing the agent did on the way to its answer."""

    type: Literal["tool_call", "retrieval", "llm_call"]
    name: str = Field(description="Tool or model name, e.g. 'lookup_fees'")
    input: Any = None
    output: Any = None
    error: str | None = Field(None, description="Set if this step failed")
    latency_ms: int | None = None


class RunIn(BaseModel):
    """What an agent sends to POST /runs once it has finished."""

    agent_name: str
    mode: RunMode = "live"
    conversation_id: str | None = Field(None, description="Groups several runs from one conversation")

    input: str = Field(description="What the agent was asked")
    output: str = Field(description="What the agent answered")
    expected_output: str | None = Field(None, description="The correct answer. Required in testing mode")
    context: list[str] = Field(default_factory=list, description="Documents the agent was given or found")
    steps: list[Step] = Field(default_factory=list)

    model: str | None = Field(None, description="The model the agent used, e.g. 'gpt-4o' or 'llama3.2'")
    tokens: int | None = None
    cost_usd: float | None = None
    latency_ms: int | None = None
    metadata: dict[str, Any] = Field(default_factory=dict, description="Anything else the agent wants to keep")

    @model_validator(mode="after")
    def testing_needs_expected_output(self):
        if self.mode == "testing" and not self.expected_output:
            raise ValueError("testing runs need an expected_output")
        return self


class Run(RunIn):
    """A run as we store it. The agent's original data is never changed after this."""

    id: str
    received_at: datetime


# ---------- Metric ----------


class Metric(BaseModel):
    """A question we ask about every run. Loaded from a YAML file."""

    id: str = Field(description="Short unique name, e.g. 'faithfulness'")
    name: str = Field(description="Shown on the dashboard, e.g. 'Faithfulness'")
    description: str
    area: Literal["Agent behaviour", "Agent capabilities", "Reliability", "Safety and alignment"]
    method: Literal["code", "llm_judge"] = Field(description="Plain Python check, or graded by Ollama")
    check: str = Field(description="Which evaluator function runs it, e.g. 'claims_supported'")
    modes: list[RunMode] = Field(default=["testing", "live"], description="Which kinds of run it applies to")
    agents: list[str] | None = Field(None, description="Only these agents. Empty means all agents")
    threshold: float = Field(ge=0, le=1, description="Score needed to pass")
    settings: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


# ---------- Result ----------


class Evidence(BaseModel):
    """One piece of the 'why': usually one claim and whether it held up."""

    item: str = Field(description="The claim, requirement or step being judged")
    verdict: Literal["passed", "failed", "missing", "left_out", "key_contradicted"] = Field(
        description="missing = the reference says nothing about this claim. "
        "left_out = this fact is in the answer key but not in the answer. "
        "key_contradicted = this fact is in the answer key and the answer says otherwise"
    )
    source: str | None = Field(None, description="What it was checked against, e.g. the policy sentence")
    note: str | None = None


class MetricResult(BaseModel):
    """One metric's result for one run."""

    run_id: str
    metric_id: str
    score: float | None = Field(None, ge=0, le=1, description="None if the metric was skipped")
    threshold: float
    passed: bool | None = Field(None, description="None if the metric was skipped")
    reason: str = Field(description="One sentence a person can read, e.g. 'Said €25, the policy says €10'")
    evidence: list[Evidence] = Field(default_factory=list)
    skipped_reason: str | None = Field(None, description="e.g. 'needs an expected answer'")
    skipped_because: Literal["missing_data", "could_not_run"] | None = Field(
        None,
        description="missing_data = the run didn't have the data this metric needs. "
        "could_not_run = our evaluation broke (e.g. the judge was down), so we don't know the result",
    )

    method: Literal["code", "llm_judge"]
    judge_model: str | None = Field(None, description="e.g. 'qwen3:8b'. Kept so scores stay comparable")
    judge_prompt_version: str | None = None
    evaluated_at: datetime


# ---------- Diagnosis (see notes/design.md) ----------


class Ref(BaseModel):
    """Where to look in the run."""

    kind: Literal["step", "context", "output", "expected_output", "metric_result"]
    id: str = Field(description="Step name, context number, or metric id")
    detail: str | None = Field(None, description="e.g. the claim text, or 'step 2' when a step name repeats")


class Observation(BaseModel):
    """Something we saw, and how we know it."""

    id: str = Field(description="Stable id, e.g. 'step-2-get_latest_prices-error'. Explanations refer to this")
    text: str
    basis: Literal["recorded", "computed", "judged"] = Field(
        description="recorded = as the agent sent it, not checked by us. "
        "computed = a deterministic check our code ran; the text states only what was checked. "
        "judged = the AI judge's opinion, which could be wrong"
    )
    refs: list[Ref] = Field(default_factory=list)
    judge_model: str | None = Field(None, description="Set when basis is 'judged'")

    @model_validator(mode="after")
    def judged_needs_a_model(self):
        if self.basis == "judged" and not self.judge_model:
            raise ValueError("a judged observation must say which judge model made it")
        return self


class Explanation(BaseModel):
    """One possible explanation. A lead, not a verdict."""

    summary: str = Field(description="e.g. 'The agent may not have used the price it retrieved.'")
    pattern: str | None = Field(None, description="Optional link to a known pattern, e.g. 'tool_failure'")
    supported_by: list[str] = Field(description="Observation ids that point to this explanation")
    weakened_by: list[str] = Field(default_factory=list, description="Observation ids that point against it")
    how_to_check: list[str] = Field(default_factory=list, description="What would confirm or rule it out")
    who_could_look: str | None = Field(None, description="A suggestion only")


class SecondOpinion(BaseModel):
    """One re-check of one judged claim by a different model. Kept so disagreements can be traced later."""

    claim: str
    original_model: str
    original_verdict: str
    model: str
    verdict: str
    agreed: bool
    prompt_version: str
    checked_at: datetime


class Diagnosis(BaseModel):
    """What the evidence shows and what might explain a failure. Never changes the run or its results."""

    run_id: str
    outcome: Literal["explanations_found", "insufficient_evidence", "not_needed"] = Field(
        description="not_needed = every metric that applies completed and none failed. "
        "explanations_found = something failed and at least one explanation is supported by observations. "
        "insufficient_evidence = something failed, or a metric couldn't run, and the evidence can't explain it"
    )
    observations: list[Observation] = Field(default_factory=list)
    explanations: list[Explanation] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)
    second_opinions: list[SecondOpinion] = Field(default_factory=list)
    method: Literal["rules", "rules+judge"]
    version: str
    diagnosed_at: datetime

    @model_validator(mode="after")
    def references_and_outcome_hold_together(self):
        ids = [observation.id for observation in self.observations]
        if len(ids) != len(set(ids)):
            raise ValueError("observation ids must be unique")
        for explanation in self.explanations:
            if not explanation.supported_by:
                raise ValueError(f"explanation '{explanation.summary}' has no supporting observations")
            for observation_id in explanation.supported_by + explanation.weakened_by:
                if observation_id not in ids:
                    raise ValueError(f"explanation refers to unknown observation '{observation_id}'")
        if self.outcome == "explanations_found" and not self.explanations:
            raise ValueError("outcome 'explanations_found' needs at least one explanation")
        if self.outcome != "explanations_found" and self.explanations:
            raise ValueError(f"outcome '{self.outcome}' can't have explanations")
        return self


class RunReport(BaseModel):
    """What POST /runs and GET /runs/{id} return: the run, every metric's result, and the diagnosis."""

    run: Run
    results: list[MetricResult]
    diagnosis: Diagnosis | None = Field(None, description="None for runs stored before diagnosis existed")
