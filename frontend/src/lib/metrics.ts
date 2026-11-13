/** Per-metric presentation: a result's state, its headline value, how it was checked, and the rule it was scored against. */

import type { MetricResult, RowResult } from "./api";
import { formatMs } from "./time";

export type ResultState = "failed" | "passed" | "could_not_run" | "missing_data";

export function stateOf(result: Pick<MetricResult, "passed" | "skipped_because">): ResultState {
  if (result.passed === false) return "failed";
  if (result.passed === true) return "passed";
  return result.skipped_because === "could_not_run" ? "could_not_run" : "missing_data";
}

/** Failed first, then passed, then the checks that could not run or had no data. */
export const STATE_RANK: Record<ResultState, number> = { failed: 0, passed: 1, could_not_run: 2, missing_data: 3 };

const LIMIT_METRICS = new Set(["latency", "cost"]);

/** A limit check (time, cost). Going over it is a budget breach, not a wrong answer, and the page says so. */
export function isLimit(result: { metric_id: string; settings?: Record<string, unknown> }): boolean {
  return LIMIT_METRICS.has(result.metric_id) || typeof result.settings?.limit === "number";
}

/** The state as the page names it: a failed limit check is "over the limit". */
export type Verdict = ResultState | "over_limit";

export function verdictOf(result: Pick<MetricResult, "metric_id" | "settings" | "passed" | "skipped_because">): Verdict {
  const state = stateOf(result);
  return state === "failed" && isLimit(result) ? "over_limit" : state;
}

/** The order checks are listed in: what the answer says, then what the agent did, then how much it took. Unknown ids go last. */
const METRIC_ORDER = ["groundedness", "correctness", "data_leakage", "execution_success", "latency", "cost"];

export function metricOrder(id: string): number {
  const at = METRIC_ORDER.indexOf(id);
  return at < 0 ? METRIC_ORDER.length : at;
}

/** "Took 22824 ms, over the 10000 ms limit." with the millisecond figures written as seconds. */
export function readableMs(text: string): string {
  return text.replace(/\b(\d{4,}) ms\b/g, (_, ms: string) => formatMs(Number(ms)));
}

const UNMET = new Set(["failed", "missing", "left_out", "key_contradicted"]);

/** The counts a run list row carries, derived from a full result. Mirrors the backend's row_result. */
export function countsOf(result: MetricResult): RowResult {
  return {
    score: result.score,
    passed: result.passed,
    failed: result.evidence.filter((e) => UNMET.has(e.verdict)).length,
    total: result.evidence.length,
  };
}

interface Measured {
  latency_ms?: number | null;
  cost_usd?: number | null;
}

/** The one value that sums up a result: "6 / 10", "1 leak", "22.8 s", "$0.0142", or the score. "—" when skipped. */
export function headline(metricId: string, r: RowResult, run: Measured): string {
  if (r.score === null || r.passed === null) return "—";
  switch (metricId) {
    case "latency":
      return run.latency_ms != null ? formatMs(run.latency_ms) : r.score.toFixed(2);
    case "cost":
      return run.cost_usd != null ? `$${run.cost_usd.toFixed(4)}` : r.score.toFixed(2);
    case "data_leakage":
      return r.failed ? `${r.failed} leak${r.failed === 1 ? "" : "s"}` : "No leaks";
    case "groundedness":
    case "execution_success":
      return r.total ? `${r.total - r.failed} / ${r.total}` : r.score.toFixed(2);
    default:
      return r.score.toFixed(2);
  }
}

function formatSetting(field: string, unit: unknown, value: number): string {
  if (field === "latency_ms") return formatMs(value);
  if (field === "cost_usd") return `$${+value.toFixed(4)}`;
  return `${+value.toFixed(2)}${typeof unit === "string" ? ` ${unit}` : ""}`;
}

/**
 * The pass rule the result was scored against, in plain words: "fails above 30.0 s", "every claim must be supported by the sources".
 * Limit metrics score 1 up to the target and 0 at the limit, so the pass boundary is where that line crosses the threshold.
 * Null when the rule can't be put plainly (a limit metric scored before settings were stored).
 */
export function rule(result: MetricResult): string | null {
  const s = result.settings ?? {};
  if (typeof s.field === "string" && typeof s.target === "number" && typeof s.limit === "number") {
    const boundary = s.limit - result.threshold * (s.limit - s.target);
    return `fails above ${formatSetting(s.field, s.unit, boundary)}`;
  }
  if (result.metric_id === "data_leakage") return "any card number, IBAN, email or phone number fails it";
  const whole: Record<string, string> = {
    groundedness: "every claim must be supported by the sources",
    execution_success: "every step must work",
    correctness: "must match the answer key",
  };
  const share: Record<string, string> = {
    groundedness: "of claims must be supported",
    execution_success: "of steps must work",
    correctness: "match with the answer key",
  };
  if (result.threshold >= 1) return whole[result.metric_id] ?? null;
  return share[result.metric_id] ? `at least ${Math.round(result.threshold * 100)}% ${share[result.metric_id]}` : null;
}
