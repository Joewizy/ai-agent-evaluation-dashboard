/**
 * Typed client for the FastAPI backend. Types mirror backend/app/schemas.py.
 *
 * The browser calls /api/*, which next.config.ts rewrites to the backend (BACKEND_URL,
 * default http://localhost:8000), so there is no CORS to configure.
 */

export type RunStatus =
  | "evaluating"
  | "passed"
  | "could_not_run"
  | "needs_review"
  | "confirmed"
  | "false_alarm"
  | "resolved";

export type ReviewVerdict = "correct" | "incorrect" | "inconclusive";
export type Method = "code" | "llm_judge";
export type Basis = "recorded" | "computed" | "judged";

export interface Step {
  type: "tool_call" | "retrieval" | "llm_call";
  name: string;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  latency_ms?: number | null;
}

export interface Run {
  id: string;
  agent_name: string;
  mode: "live" | "testing";
  received_at: string;
  conversation_id?: string | null;
  input: string;
  output: string;
  expected_output?: string | null;
  context: string[];
  instructions?: string | null;
  steps: Step[];
  model?: string | null;
  tokens?: number | null;
  cost_usd?: number | null;
  latency_ms?: number | null;
}

export interface Evidence {
  item: string;
  verdict: "passed" | "failed" | "missing" | "left_out" | "key_contradicted";
  source?: string | null;
  found_in?: string | null;
  note?: string | null;
  /** [start, end) in the answer, when code located the item there (a leak). */
  span?: [number, number] | null;
}

export interface MetricResult {
  run_id: string;
  metric_id: string;
  score: number | null;
  threshold: number;
  /** The metric's settings as applied to this run (per-agent overrides merged). Absent on older results. */
  settings?: Record<string, unknown>;
  passed: boolean | null;
  reason: string;
  evidence: Evidence[];
  skipped_reason?: string | null;
  skipped_because?: "missing_data" | "could_not_run" | null;
  method: Method;
  review?: "person" | "auto";
  judge_model?: string | null;
  judge_prompt_version?: string | null;
  evaluated_at: string;
}

export interface Ref {
  kind: "step" | "context" | "instructions" | "output" | "expected_output" | "metric_result";
  id: string;
  detail?: string | null;
}

export interface Observation {
  id: string;
  text: string;
  basis: Basis;
  refs: Ref[];
  judge_model?: string | null;
  match?: "exact" | "record" | null;
}

export interface Explanation {
  summary: string;
  pattern?: string | null;
  supported_by: string[];
  weakened_by: string[];
  how_to_check: string[];
  who_could_look?: string | null;
}

export interface SecondOpinion {
  claim: string;
  original_model: string;
  original_verdict: string;
  model: string;
  verdict: string;
  agreed: boolean;
  prompt_version: string;
  checked_at: string;
}

export interface Diagnosis {
  run_id: string;
  outcome: "explanations_found" | "insufficient_evidence" | "not_needed";
  observations: Observation[];
  explanations: Explanation[];
  caveats: string[];
  second_opinions: SecondOpinion[];
  method: "rules" | "rules+judge";
  version: string;
  diagnosed_at: string;
}

export interface ReviewIn {
  target: "metric_result" | "explanation";
  metric_id?: string;
  explanation?: number;
  verdict: ReviewVerdict;
  note?: string;
  reviewer: string;
}

export interface Review extends ReviewIn {
  id: string;
  run_id: string;
  reviewed_at: string;
}

export interface ResolutionIn {
  action: string;
  resolved_by: string;
}

export interface Resolution extends ResolutionIn {
  run_id: string;
  resolved_at: string;
}

export interface RunReport {
  run: Run;
  status: RunStatus;
  results: MetricResult[];
  diagnosis: Diagnosis | null;
  reviews: Review[];
  resolution: Resolution | null;
}

/** One metric's result in a run list row: enough to show a value without loading the run. */
export interface RowResult {
  score: number | null;
  passed: boolean | null;
  failed: number;
  total: number;
}

export interface RunRow {
  id: string;
  agent_name: string;
  mode: "live" | "testing";
  received_at: string;
  status: RunStatus;
  latency_ms?: number | null;
  cost_usd?: number | null;
  failed_metrics: string[];
  results?: Record<string, RowResult>;
  causes: string[];
}

export interface ReviewCount {
  correct: number;
  incorrect: number;
  inconclusive: number;
  agreement: number | null;
}

export interface MetricSummary {
  name: string;
  scored: number;
  failed: number;
  missing_data: number;
  could_not_run: number;
  average_score: number | null;
}

export interface Action {
  run_id: string;
  agent_name: string;
  action: string;
  resolved_by: string;
  resolved_at: string;
}

export interface Summary {
  since: string;
  runs: number;
  by_status: Partial<Record<RunStatus, number>>;
  by_agent: Record<string, { runs: number; failed: number; could_not_run: number }>;
  metrics: Record<string, MetricSummary>;
  failed_runs: number;
  failures_by_cause: Record<string, number>;
  runs_with_several_causes: number;
  pending_reviews: number;
  actions: Action[];
  judge_vs_humans: ReviewCount;
  /** Reviews of metric results, by metric id. Absent from older backends. */
  agreement_by_metric?: Record<string, ReviewCount>;
  explanations_reviewed: ReviewCount;
}

export interface MetricInfo {
  id: string;
  name: string;
  description: string;
  method: Method;
  judge_model: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(BASE + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
      cache: "no-store",
    });
  } catch {
    throw new ApiError("Can't reach the evaluation API.", 0);
  }
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (typeof body.detail === "string") detail = body.detail;
      else if (Array.isArray(body.detail)) detail = body.detail.map((d: { msg: string }) => d.msg).join("; ");
    } catch {
      // not JSON: keep the status line
    }
    // The Next.js proxy answers 500 when the backend isn't running.
    if (response.status >= 500 && detail.startsWith("500")) detail = "Can't reach the evaluation API.";
    throw new ApiError(detail, response.status);
  }
  return response.json() as Promise<T>;
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const api = {
  summary: (params: { since?: string; agent?: string } = {}) => request<Summary>(`/summary${query(params)}`),
  runs: (params: { since?: string; agent?: string; status?: RunStatus } = {}) =>
    request<RunRow[]>(`/runs${query(params)}`),
  run: (id: string) => request<RunReport>(`/runs/${encodeURIComponent(id)}`),
  metrics: () => request<MetricInfo[]>("/metrics"),
  addReview: (id: string, review: ReviewIn) =>
    request<Review>(`/runs/${encodeURIComponent(id)}/reviews`, { method: "POST", body: JSON.stringify(review) }),
  resolve: (id: string, resolution: ResolutionIn) =>
    request<Resolution>(`/runs/${encodeURIComponent(id)}/resolution`, {
      method: "POST",
      body: JSON.stringify(resolution),
    }),
};
