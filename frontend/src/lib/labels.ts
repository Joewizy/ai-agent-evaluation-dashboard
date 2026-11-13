/** Plain-language labels. The UI never shows a raw status, pattern or verdict id. */

import type { MetricInfo, ReviewVerdict, RunStatus } from "./api";

export type StatusKey = "eval" | "pass" | "cnc" | "need" | "conf" | "fa" | "res";

export const STATUS: Record<RunStatus, { label: string; key: StatusKey }> = {
  passed: { label: "Passed", key: "pass" },
  needs_review: { label: "Needs review", key: "need" },
  confirmed: { label: "Confirmed", key: "conf" },
  false_alarm: { label: "False alarm", key: "fa" },
  resolved: { label: "Resolved", key: "res" },
  could_not_run: { label: "Couldn’t be checked", key: "cnc" },
  evaluating: { label: "Evaluating", key: "eval" },
};

/** Order used by the status bar, the legend and the run list tabs. */
export const STATUS_ORDER: RunStatus[] = [
  "passed",
  "needs_review",
  "confirmed",
  "false_alarm",
  "resolved",
  "could_not_run",
  "evaluating",
];

export function isStatus(value: string | null): value is RunStatus {
  return value !== null && value in STATUS;
}

const PATTERNS: Record<string, string> = {
  tool_failure: "Tool failure",
  answer_contradicts_context: "Answer contradicts sources",
  claim_not_in_context: "Claim not in sources",
  context_disagrees_with_answer_key: "Sources disagree with answer key",
  fact_missing_from_context: "Fact missing from sources",
  no_explanation: "No explanation found",
  other: "Other",
};

export function patternLabel(pattern: string | null | undefined): string {
  if (!pattern) return "Other";
  return PATTERNS[pattern] ?? sentence(pattern);
}

export const REVIEW_LABEL: Record<ReviewVerdict, string> = {
  correct: "Correct",
  incorrect: "Incorrect",
  inconclusive: "Not sure",
};

export type ReviewTarget = "metric_result" | "explanation";

/** What a reviewer is asked. A failed check and an explanation are different questions, so the words differ. */
export const REVIEW_QUESTION: Record<ReviewTarget, string> = {
  metric_result: "Is this failure real?",
  explanation: "Does this explanation hold up?",
};

/** The verdict as the reviewer sees it. Stored as correct / incorrect / inconclusive in both cases. */
export function reviewLabel(target: ReviewTarget, verdict: ReviewVerdict): string {
  if (target === "metric_result") return { correct: "Real failure", incorrect: "False alarm", inconclusive: "Not sure" }[verdict];
  return { correct: "It holds", incorrect: "It doesn’t", inconclusive: "Not sure" }[verdict];
}

/** Claim verdicts as the judge gives them (evidence verdicts from "Grounded"). */
export const CLAIM_VERDICT = {
  passed: { label: "Supported by the sources", bg: "var(--hl-ok-bg)", fg: "var(--hl-ok-fg)", line: "var(--s-pass)" },
  failed: { label: "Contradicts the sources", bg: "var(--hl-bad-bg)", fg: "var(--hl-bad-fg)", line: "var(--s-conf)" },
  missing: {
    label: "Not mentioned in the sources",
    bg: "var(--hl-amb-bg)",
    fg: "var(--hl-amb-fg)",
    line: "var(--s-need)",
  },
} as const;

/** The backend's label for the agent's system prompt and tool descriptions, as a source. */
export const INSTRUCTIONS_SOURCE = "agent instructions";

const FROM_INSTRUCTIONS = {
  label: "Supported by the agent’s instructions",
  bg: "var(--hl-info-bg)",
  fg: "var(--hl-info-fg)",
  line: "var(--accent)",
} as const;

export type ClaimLook = { label: string; bg: string; fg: string; line: string };

/** How a claim is shown: a backed claim whose quote is in the agent's own instructions gets its own look. */
export function claimLook(evidence: { verdict: keyof typeof CLAIM_VERDICT; found_in?: string | null }): ClaimLook {
  return evidence.verdict === "passed" && evidence.found_in === INSTRUCTIONS_SOURCE ? FROM_INSTRUCTIONS : CLAIM_VERDICT[evidence.verdict];
}

/** Second-opinion verdicts, stored as supported / contradicted / not_mentioned. */
export function judgeVerdictLabel(verdict: string): string {
  return { supported: "supported", contradicted: "contradicted", not_mentioned: "not mentioned" }[verdict] ?? sentence(verdict);
}

export const STEP_TYPE = { tool_call: "Tool call", retrieval: "Retrieval", llm_call: "Model" } as const;

export function metricName(id: string, metrics: MetricInfo[] | undefined): string {
  return metrics?.find((m) => m.id === id)?.name ?? sentence(id);
}

/** "fact_missing_from_context" -> "Fact missing from context": a fallback for ids we don't know yet. */
function sentence(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
