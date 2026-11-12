/** Text helpers for the run page: placing claims in the answer and the judge's quotes in the sources. */

import type { Evidence, MetricResult, Run } from "./api";

export interface Claim {
  index: number;
  evidence: Evidence & { verdict: "passed" | "failed" | "missing" };
  judgeModel: string | null;
}

/** Claims the judge checked against the sources ("Backed by sources"), in order. */
export function claimsOf(results: MetricResult[]): Claim[] {
  const grounded = results.find((r) => r.metric_id === "groundedness");
  if (!grounded) return [];
  return grounded.evidence
    .filter((e): e is Claim["evidence"] => e.verdict === "passed" || e.verdict === "failed" || e.verdict === "missing")
    .map((evidence, index) => ({ index, evidence, judgeModel: grounded.judge_model ?? null }));
}

export interface Segment {
  text: string;
  /** Indexes into the claims list: the claims the judge took from this sentence. Empty for plain text. */
  claims: number[];
}

const STOP_WORDS = new Set(
  (
    "the a an is are was were be been of for to in on at and or it its that this these those with as by can could " +
    "about also from has have had not but if than then there their they them which who will would may might do does " +
    "did you your we our us i my me im like need other various one any all some such into up out so s"
  ).split(" "),
);

/** The words that carry a sentence's meaning. "I", "my" and "me" count as "assistant", the judge's word for the agent. */
function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0];
    if (word === "i" || word === "my" || word === "me" || word === "im") words.add("assistant");
    if (word.length >= 2 && !STOP_WORDS.has(word)) words.add(word);
  }
  return words;
}

/** Sentence ranges of a text: split after . ! ? followed by whitespace, and at line breaks. */
function sentencesOf(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  for (const match of text.matchAll(/(?<=[.!?])\s+|\n+/g)) {
    const end = match.index ?? 0;
    if (end > start) ranges.push({ start, end });
    start = end + match[0].length;
  }
  if (start < text.length) ranges.push({ start, end: text.length });
  return ranges;
}

/**
 * Map each claim the judge checked to the sentence of the answer it came from, so the answer can be
 * highlighted sentence by sentence. A claim that is quoted word for word wins; otherwise the sentence
 * sharing most of the claim's words, if it shares at least half of them. The judge rewords claims
 * ("I can show the table" becomes "The assistant can provide the table"), so exact matching alone
 * places almost nothing. Claims that fit no sentence are returned separately.
 */
export function placeClaims(answer: string, claims: Claim[]): { segments: Segment[]; unplaced: Claim[] } {
  const sentences = sentencesOf(answer).map((range) => {
    const text = answer.slice(range.start, range.end);
    return { ...range, text, lower: text.toLowerCase(), words: contentWords(text), claims: [] as number[] };
  });
  const unplaced: Claim[] = [];
  for (const claim of claims) {
    const needle = claim.evidence.item.trim().replace(/[.!?]+$/, "").toLowerCase();
    const words = contentWords(claim.evidence.item);
    let best = -1;
    let bestScore = 0;
    sentences.forEach((sentence, i) => {
      let score = 0;
      if (needle && sentence.lower.includes(needle)) score = 2;
      else if (words.size) {
        let shared = 0;
        for (const word of words) if (sentence.words.has(word)) shared++;
        score = shared >= 2 ? shared / words.size : 0;
      }
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best >= 0 && bestScore >= 0.5) sentences[best].claims.push(claim.index);
    else unplaced.push(claim);
  }

  const segments: Segment[] = [];
  let cursor = 0;
  for (const sentence of sentences) {
    if (sentence.start > cursor) segments.push({ text: answer.slice(cursor, sentence.start), claims: [] });
    segments.push({ text: sentence.text, claims: sentence.claims });
    cursor = sentence.end;
  }
  if (cursor < answer.length) segments.push({ text: answer.slice(cursor), claims: [] });
  return { segments, unplaced };
}

/** Markdown bold (**like this**) split into plain and bold runs; the asterisks themselves are dropped. */
export function boldRuns(text: string): { text: string; bold: boolean }[] {
  return text
    .split("**")
    .map((part, i) => ({ text: part, bold: i % 2 === 1 }))
    .filter((run) => run.text);
}

/** The first sentence of a reason, e.g. "4 of 10 claims aren't backed by the sources." */
export function firstSentence(text: string): string {
  const match = /^.*?[.!?](?=\s|$)/.exec(text);
  return match ? match[0] : text;
}

/** Split text into plain and highlighted parts wherever one of the quotes appears (ignoring case). */
export function highlight(text: string, quotes: string[]): { text: string; hl: boolean }[] {
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const quote of quotes) {
    const needle = quote.trim().toLowerCase();
    if (needle.length < 3) continue;
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
      ranges.push([at, at + needle.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const parts: { text: string; hl: boolean }[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    if (from > cursor) parts.push({ text: text.slice(cursor, from), hl: false });
    parts.push({ text: text.slice(from, end), hl: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hl: false });
  return parts;
}

/** Any value an agent sent, as readable text. */
export function asText(value: unknown, pretty = false): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, pretty ? 2 : undefined);
  } catch {
    return String(value);
  }
}

export function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A one-line description of what a step returned. */
export function describeOutput(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  const text = asText(value);
  return text.length <= 80 ? text : `${text.length.toLocaleString()} characters`;
}

export interface Source {
  label: string;
  title?: string;
  from?: string;
  text: string;
  empty?: boolean;
}

/** A search result that is a list of passages the agent also sent as context. Mirrors the backend's already_in_context. */
function alreadyInContext(output: unknown, context: string[]): boolean {
  if (!Array.isArray(output) || output.length === 0 || context.length === 0) return false;
  const joined = context.join("\n");
  return output.every((item) => {
    const text = item && typeof item === "object" ? (item as { text?: unknown }).text : undefined;
    return typeof text === "string" && text.trim() !== "" && joined.includes(text);
  });
}

/** What the agent had to work with: its context, then what each tool or search returned. Mirrors the backend's sources_for. */
export function sourcesOf(run: Run): Source[] {
  const sources: Source[] = run.instructions ? [{ label: "Agent instructions", text: run.instructions }] : [];
  sources.push(...run.context.map((text, i) => ({ label: `Context ${i + 1}`, text })));
  run.steps.forEach((step, i) => {
    if (step.type === "llm_call") return;
    if (!step.error && alreadyInContext(step.output, run.context)) return; // shown above as context
    const label = step.type === "tool_call" ? "Tool result" : "Search result";
    if (step.error) {
      sources.push({ label, title: step.name, from: `step ${i + 1}`, text: `No result: ${step.error}`, empty: true });
    } else if (step.output !== null && step.output !== undefined && step.output !== "") {
      sources.push({ label, title: step.name, from: `step ${i + 1}`, text: asText(step.output, true) });
    }
  });
  return sources;
}

/** Which source a quote came from, e.g. "Context 1" or "Tool result · get_prices". */
export function whereQuoted(quote: string, sources: Source[]): string | null {
  const needle = quote.trim().toLowerCase();
  const found = sources.find((s) => !s.empty && s.text.toLowerCase().includes(needle));
  if (!found) return null;
  return found.title ? `${found.label} · ${found.title}` : found.label;
}
