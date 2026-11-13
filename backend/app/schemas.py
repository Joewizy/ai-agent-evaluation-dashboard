"""The shapes of the data the backend works with.

The main things:
  Run           - what the agent did (sent to us by the agent)
  Metric        - a question we ask about every run
  MetricResult  - one metric's answer for one run, with the reason
  Diagnosis     - what the evidence shows and what might explain a failure
  Review        - a person's verdict on a metric result or an explanation

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

    agent_name: str = Field(min_length=1, description="Which agent sent the run. Per-agent limits in the metric YAML files use it")
    mode: RunMode = "live"
    conversation_id: str | None = Field(None, description="Groups several runs from one conversation")

    input: str = Field(description="What the agent was asked")
    output: str = Field(description="What the agent answered")
    expected_output: str | None = Field(None, description="The correct answer. Required in testing mode")
    context: list[str] = Field(default_factory=list, description="Documents the agent was given or found")
    instructions: str | None = Field(
        None,
        description="The agent's system prompt and tool descriptions. A source like any other, so what the agent "
        "says about itself (\"I can look up league tables\") can be checked instead of counted as made up",
    )
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

ReviewMode = Literal["person", "auto"]
"""How a failed result is confirmed.

person: a reviewer must confirm the failure (metrics decided by an AI judge or by a heuristic rule).
auto: the failure is a measurement (latency, cost, an error recorded by the agent) and is confirmed without a review."""


class AgentOverride(BaseModel):
    """Changes to a metric for one agent, e.g. a longer time limit for an agent on a local model."""

    enabled: bool | None = None
    threshold: float | None = Field(None, ge=0, le=1)
    settings: dict[str, Any] = Field(default_factory=dict, description="Merged over the metric's settings")


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
    review: ReviewMode = Field("person", description="Whether a failure needs a person's review or is confirmed as measured")
    per_agent: dict[str, AgentOverride] = Field(default_factory=dict, description="Overrides by agent name")

    def for_agent(self, agent_name: str) -> "Metric":
        """This metric as it applies to one agent, with that agent's overrides merged in."""
        override = self.per_agent.get(agent_name)
        if override is None:
            return self
        changes: dict[str, Any] = {"settings": {**self.settings, **override.settings}}
        if override.enabled is not None:
            changes["enabled"] = override.enabled
        if override.threshold is not None:
            changes["threshold"] = override.threshold
        return self.model_copy(update=changes)


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
    found_in: str | None = Field(None, description="Which source our code found the quote in, e.g. 'context 1' or 'agent instructions'")
    note: str | None = None
    span: list[int] | None = Field(
        None,
        min_length=2,
        max_length=2,
        description="Character offsets [start, end) of this item in the answer, when code located it there (e.g. a leak)",
    )


class MetricResult(BaseModel):
    """One metric's result for one run."""

    run_id: str
    metric_id: str
    score: float | None = Field(None, ge=0, le=1, description="None if the metric was skipped")
    threshold: float
    settings: dict[str, Any] = Field(
        default_factory=dict,
        description="The metric's settings as applied to this run, with any per-agent override merged, so the pass rule can be shown",
    )
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
    review: ReviewMode = Field("person", description="auto = a failure is a measurement and counts as confirmed without a review")
    judge_model: str | None = Field(None, description="e.g. 'qwen3:8b'. Kept so scores stay comparable")
    judge_prompt_version: str | None = None
    evaluated_at: datetime


# ---------- Diagnosis ----------


class Ref(BaseModel):
    """Where to look in the run."""

    kind: Literal["step", "context", "instructions", "output", "expected_output", "metric_result"]
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
    match: Literal["exact", "record"] | None = Field(
        None,
        description="For a quote our code found: exact = word for word; record = reworded, but the same names and "
        "numbers are in one JSON record. Weaker than exact",
    )

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


# ---------- Human review and status ----------

ReviewVerdict = Literal["correct", "incorrect", "inconclusive"]

RunStatus = Literal["evaluating", "passed", "could_not_run", "needs_review", "confirmed", "false_alarm", "resolved"]
"""evaluating = not scored yet. passed = nothing failed and everything ran.
could_not_run = nothing failed, but a metric couldn't run (e.g. the judge was down): neither a pass nor a fail.
needs_review = a failure that needs a person (an AI judge or a fallible rule decided it) hasn't been reviewed yet.
confirmed = at least one failure is real: a person agreed, or it's a measurement (review: auto) and nothing waits for a person.
false_alarm = a person said every failure was wrong.
resolved = someone recorded the action taken."""


class ReviewIn(BaseModel):
    """A person's verdict on one metric result or one explanation. Two levels, kept apart:
    "was the metric right?" measures the judge; "was the explanation right or useful?" measures the diagnosis."""

    target: Literal["metric_result", "explanation"]
    metric_id: str | None = Field(None, description="Which metric result, when target is metric_result")
    explanation: int | None = Field(None, ge=0, description="Which explanation (its position in the diagnosis), when target is explanation")
    verdict: ReviewVerdict
    note: str | None = Field(None, description="Why, in a sentence")
    reviewer: str

    @model_validator(mode="after")
    def names_its_target(self):
        if self.target == "metric_result" and (self.metric_id is None or self.explanation is not None):
            raise ValueError("a metric_result review needs metric_id (and no explanation)")
        if self.target == "explanation" and (self.explanation is None or self.metric_id is not None):
            raise ValueError("an explanation review needs explanation (and no metric_id)")
        return self


class Review(ReviewIn):
    """Stored next to what it reviews, never over it. A later review of the same thing takes precedence."""

    id: str
    run_id: str
    reviewed_at: datetime


class ResolutionIn(BaseModel):
    action: str = Field(description="What was done, e.g. 'Fixed the price tool timeout'")
    resolved_by: str


class Resolution(ResolutionIn):
    run_id: str
    resolved_at: datetime


class RunReport(BaseModel):
    """What POST /runs and GET /runs/{id} return: the run, every metric's result, the diagnosis, and its review."""

    run: Run
    status: RunStatus
    results: list[MetricResult]
    diagnosis: Diagnosis | None = Field(None, description="None while evaluating, and for runs stored before diagnosis existed")
    reviews: list[Review] = Field(default_factory=list)
    resolution: Resolution | None = None


class RowResult(BaseModel):
    """One metric's result in a run list row: enough to show a value without loading the run."""

    score: float | None
    passed: bool | None
    failed: int = Field(0, description="Evidence items that did not hold: unbacked claims, failed steps, leaks")
    total: int = Field(0, description="Evidence items checked")


class RunRow(BaseModel):
    """One line in the run list."""

    id: str
    agent_name: str
    mode: RunMode
    received_at: datetime
    status: RunStatus
    latency_ms: int | None = None
    cost_usd: float | None = None
    failed_metrics: list[str]
    results: dict[str, RowResult] = Field(default_factory=dict, description="By metric id")
    causes: list[str] = Field(description="Explanation patterns, or 'no_explanation' when a failure has none")


class ReviewCount(BaseModel):
    correct: int = 0
    incorrect: int = 0
    inconclusive: int = 0
    agreement: float | None = Field(None, description="correct / (correct + incorrect); inconclusive left out. None if nothing reviewed")


class MetricSummary(BaseModel):
    name: str
    scored: int = 0
    failed: int = 0
    missing_data: int = 0
    could_not_run: int = Field(0, description="Shown separately and left out of the average: neither a pass nor a fail")
    average_score: float | None = None


class Action(BaseModel):
    """One recorded action, for the "Actions taken" list."""

    run_id: str
    agent_name: str
    action: str
    resolved_by: str
    resolved_at: datetime


class MetricInfo(BaseModel):
    """GET /metrics: what each metric is called and how it's checked, so the dashboard never shows raw ids."""

    id: str
    name: str
    description: str
    method: Literal["code", "llm_judge"]
    judge_model: str | None = Field(None, description="The judge this metric uses now, for llm_judge metrics")


class AgentSummary(BaseModel):
    runs: int = 0
    failed: int = 0
    could_not_run: int = 0


class Summary(BaseModel):
    """GET /summary: what happened since a point in time (this morning by default)."""

    since: datetime
    runs: int
    by_status: dict[str, int]
    by_agent: dict[str, AgentSummary]
    metrics: dict[str, MetricSummary]
    failed_runs: int = Field(description="Runs where at least one metric failed. The total to show next to the causes")
    failures_by_cause: dict[str, int] = Field(
        description="Failed runs per POSSIBLE cause (explanation pattern; 'no_explanation' when nothing explains it). "
        "A run with two possible causes counts under both, so these can add up to more than failed_runs. "
        "Show them as 'runs where this was a possible cause', not as shares of a whole"
    )
    runs_with_several_causes: int = Field(description="Failed runs counted under more than one cause, so the overlap can be stated")
    pending_reviews: int
    actions: list[Action] = Field(description="Actions recorded on these runs, newest first")
    judge_vs_humans: ReviewCount = Field(description="Reviews of AI-judged metric results: how often people agreed with the judge")
    agreement_by_metric: dict[str, ReviewCount] = Field(
        default_factory=dict,
        description="Reviews of metric results, by metric id: how often reviewers said the failure was real",
    )
    explanations_reviewed: ReviewCount = Field(description="Reviews of explanations: how often people found them right or useful")
