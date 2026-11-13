"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { api, type Diagnosis, type MetricInfo, type MetricResult, type Run, type RunReport, type Step } from "@/lib/api";
import { announceChange } from "@/lib/browser-state";
import { CLAIM_VERDICT, type ClaimLook, claimLook, INSTRUCTIONS_SOURCE, metricName, STEP_TYPE } from "@/lib/labels";
import { countsOf, headline, isLimit, metricOrder, readableMs, rule, STATE_RANK, stateOf, verdictOf } from "@/lib/metrics";
import {
  alreadyInContext,
  asText,
  boldRuns,
  type Claim,
  claimsOf,
  describeOutput,
  distinctSpans,
  firstSentence,
  highlight as highlightQuotes,
  markSpans,
  placeClaims,
  shorten,
  type Source,
  sourcesOf,
  type Span,
} from "@/lib/run-text";
import { formatMs, formatTime } from "@/lib/time";
import { useResource } from "@/lib/use-resource";
import { Card, ErrorNote, Icon, JudgeBadge, Loading, ResultChip, StatusChip } from "../ui";
import { Evidence, quoteCheck } from "./run-evidence";
import { ReviewRail } from "./run-review";
import { Section, SPINE } from "./section";

/** Lineage sections, in page order. The check tiles sit above them and the review rail beside them. */
const SECTIONS = [
  ["sec-did", "What the agent saw and said"],
  ["sec-observed", "What we observed"],
  ["sec-explain", "Possible explanations"],
] as const;

/** Which checks' findings are marked in the answer: every one, one metric id, or none. */
type Highlight = "all" | "none" | string;

export function RunView() {
  const { id } = useParams<{ id: string }>();
  // Poll only while the run is still being scored.
  const report = useResource(`run:${id}`, () => api.run(id), (data) => data?.status === "evaluating");
  const metrics = useResource("metrics", api.metrics);

  if (report.error && !report.data) {
    return (
      <Shell id={id}>
        <ErrorNote error={report.error} onRetry={report.error.message === "Run not found" ? undefined : report.refresh} />
      </Shell>
    );
  }
  if (!report.data) {
    return (
      <Shell id={id}>
        <Loading />
      </Shell>
    );
  }
  return (
    <RunPage
      report={report.data}
      metrics={metrics.data}
      now={report.updatedAt ?? new Date(report.data.run.received_at)}
      onChanged={() => {
        report.refresh();
        announceChange();
      }}
    />
  );
}

function Shell({ id, children }: { id: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex max-w-[1560px] flex-col gap-[18px] px-8 pt-5 pb-[120px]">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px] text-ink-3">
        <Link href="/runs" className="inline-flex h-9 items-center gap-1 rounded-md pr-2.5 pl-1 font-medium text-ink-2 no-underline hover:bg-surface-2">
          <Icon.ChevronLeft />
          Runs
        </Link>
        <span aria-hidden="true">/</span>
        <span className="mono">{id.slice(0, 8)}</span>
      </nav>
      {children}
    </main>
  );
}

/** One line that says where the run stands, e.g. "Grounded failed. Speed is over the limit." */
function verdictLine(report: RunReport, metrics?: MetricInfo[]): string {
  const { status, results, resolution } = report;
  if (status === "evaluating") return "Being scored. This usually takes under a minute.";
  const scored = results.filter((r) => r.passed !== null);
  const failed = scored.filter((r) => r.passed === false);
  const couldNotRun = results.filter((r) => r.skipped_because === "could_not_run");
  const names = (list: MetricResult[]) => list.map((r) => metricName(r.metric_id, metrics)).join(", ");
  if (failed.length) {
    const wrong = failed.filter((r) => !isLimit(r));
    const over = failed.filter(isLimit);
    const base = [
      ...(wrong.length ? [`${names(wrong)} failed.`] : []),
      ...(over.length ? [`${names(over)} ${over.length === 1 ? "is" : "are"} over the limit.`] : []),
    ].join(" ");
    if (status === "resolved" && resolution) return `${base} Resolved: ${resolution.action}`;
    if (status === "false_alarm") return `${base} Reviewers ruled every failure a false alarm.`;
    if (status === "confirmed") return `${base} Confirmed, waiting for an action.`;
    return base;
  }
  if (couldNotRun.length) return `Nothing failed, but ${names(couldNotRun)} couldn’t run, so this isn’t a pass.`;
  return `All ${scored.length} checks passed.`;
}

/** Leaks located in the answer by the "No data leaked" check. */
function leakSpans(results: MetricResult[]): Span[] {
  const leaks = results.find((r) => r.metric_id === "data_leakage");
  return (leaks?.evidence ?? []).flatMap((e) => (e.span ? [{ start: e.span[0], end: e.span[1] }] : []));
}

/** Failed checks first, then passed, then skipped; within each, the usual metric order. */
function orderResults(results: MetricResult[]): MetricResult[] {
  return [...results].sort(
    (a, b) => STATE_RANK[stateOf(a)] - STATE_RANK[stateOf(b)] || metricOrder(a.metric_id) - metricOrder(b.metric_id),
  );
}

function RunPage({ report, metrics, now, onChanged }: { report: RunReport; metrics?: MetricInfo[]; now: Date; onChanged: () => void }) {
  const { run, status, results, diagnosis } = report;
  const failed = results.some((r) => r.passed === false);
  const evaluating = status === "evaluating";
  const [highlight, setHighlight] = useState<Highlight>("all");
  // Initially the first failed check.
  const [selected, setSelected] = useState<string | null>(() => orderResults(results).find((r) => r.passed === false)?.metric_id ?? null);
  const claims = claimsOf(results);
  const leaks = leakSpans(results);
  const highlightable = [...(claims.length ? ["groundedness"] : []), ...(leaks.length ? ["data_leakage"] : [])];
  const onlyLimits = failed && results.filter((r) => r.passed === false).every(isLimit);
  const verdictTone = !failed || status === "resolved" ? "text-ink-2" : onlyLimits ? "font-medium text-s-need-fg" : "font-medium text-s-conf-fg";

  const meta = [
    formatTime(run.received_at, now),
    run.tokens != null ? `${run.tokens.toLocaleString()} tokens` : null,
    run.model ?? null,
  ].filter((m): m is string => !!m);

  const highlightFromHeader = (value: Highlight) => {
    setHighlight(value);
    document.getElementById("answer")?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const selectedResult = results.find((r) => r.metric_id === selected) ?? null;

  return (
    <Shell id={run.id}>
      <Card className="flex flex-col gap-3.5 px-6 py-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-ink-2">
          <span className="mono text-sm font-semibold text-ink">{run.agent_name || "unnamed agent"}</span>
          <span
            className={`inline-flex h-[22px] items-center rounded px-2 text-xs font-semibold ${
              run.mode === "live" ? "bg-surface-2 text-ink" : "border border-dashed border-ink-3 text-ink-2"
            }`}
          >
            {run.mode === "live" ? "Live" : "Testing"}
          </span>
          {meta.map((m) => (
            <span key={m}>{m}</span>
          ))}
          <span className="ml-auto">
            <StatusChip status={status} size="lg" />
          </span>
        </div>
        <h1 className="m-0 font-serif text-[28px] leading-snug font-normal tracking-[-0.01em]">{run.input}</h1>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className={`m-0 text-[15px] leading-normal ${verdictTone}`}>{verdictLine(report, metrics)}</p>
          {status === "needs_review" ? (
            <a href="#review" className="inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink no-underline hover:opacity-90 min-[1200px]:hidden">
              Review this run
            </a>
          ) : null}
        </div>
        {!evaluating && results.length > 0 ? (
          <>
            <Tiles results={results} run={run} metrics={metrics} selected={selected} onSelect={setSelected} />
            {selectedResult ? (
              <CheckDetail result={selectedResult} run={run} highlightable={highlightable} highlight={highlight} onHighlight={highlightFromHeader} />
            ) : null}
          </>
        ) : null}
      </Card>

      <nav aria-label="Run lineage" className="flex flex-wrap items-center gap-0.5 pt-0.5 pb-1 text-[13px]">
        {SECTIONS.map(([anchor, label], i) => (
          <span key={anchor} className="inline-flex items-center gap-0.5">
            <a href={`#${anchor}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg pr-1.5 pl-0.5 font-medium whitespace-nowrap text-ink-2 no-underline hover:bg-surface-2">
              <span className={`grid size-[22px] flex-none place-items-center rounded-full border-[1.5px] text-[11px] font-semibold ${SPINE.neutral}`}>{i + 1}</span>
              {label}
            </a>
            {i < SECTIONS.length - 1 ? <Icon.ChevronRight size={14} stroke="var(--ink3)" /> : null}
          </span>
        ))}
      </nav>

      <div className="grid gap-6 [grid-template-columns:minmax(0,1fr)] min-[1200px]:[grid-template-columns:minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col">
          <Section n={1} id="sec-did" title="What the agent saw and said">
            <Transcript
              report={report}
              metrics={metrics}
              claims={claims}
              leaks={leaks}
              highlight={highlight}
              highlightable={highlightable}
              onHighlight={setHighlight}
            />
          </Section>

          {evaluating ? (
            <Section n={2} id="sec-observed" title="What we observed" last>
              <Card className="flex items-center gap-3 px-5 py-4 text-sm text-ink-2">
                <span className="size-2 animate-pulse-dot rounded-full bg-s-eval" />
                Scoring this run. This usually takes under a minute, and this page updates on its own.
              </Card>
            </Section>
          ) : (
            <Evidence report={report} failed={failed} metrics={metrics} />
          )}
          {diagnosis === null && !evaluating ? (
            <p className="m-0 text-[13px] text-ink-3">This run was stored before diagnosis existed, so it has no observations or explanations.</p>
          ) : null}
        </div>

        <aside id="review" className="rail scroll-mt-4">
          <h2 className="eyebrow">Review</h2>
          <ReviewRail report={report} failed={failed} metrics={metrics} now={now} onChanged={onChanged} />
        </aside>
      </div>
    </Shell>
  );
}

// ---------- Header: one tile per check, and the selected one explained ----------

const VALUE_TONE: Record<ReturnType<typeof verdictOf>, string> = {
  failed: "text-s-conf-fg",
  over_limit: "text-s-need-fg",
  passed: "text-ink",
  could_not_run: "text-ink-3",
  missing_data: "text-ink-3",
};

/** The short line under a tile's value, e.g. "9 of 9 claims supported" or "fails above 30.0 s". */
function tileLine(result: MetricResult): string {
  const state = stateOf(result);
  if (state !== "failed" && state !== "passed") return result.skipped_reason ? capitalise(result.skipped_reason) : "Not checked";
  const counts = countsOf(result);
  switch (result.metric_id) {
    case "groundedness":
      return `${counts.total - counts.failed} of ${counts.total} claims supported`;
    case "correctness":
      return state === "passed" ? "Matches the answer key" : "Doesn’t match the answer key";
    case "execution_success":
      return `${counts.total - counts.failed} of ${counts.total} steps worked`;
    case "data_leakage":
      return counts.failed ? `${counts.failed} found in the answer` : "Nothing found in the answer";
    default: {
      const text = rule(result);
      if (text) return text;
      // Older results have no settings: use the reason's tail, "over the 10.0 s limit".
      const tail = readableMs(firstSentence(result.reason)).split(", ")[1];
      return tail ? tail.replace(/\.$/, "") : "";
    }
  }
}

function Tiles({
  results,
  run,
  metrics,
  selected,
  onSelect,
}: {
  results: MetricResult[];
  run: Run;
  metrics?: MetricInfo[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(168px,100%),1fr))]">
      {orderResults(results).map((result) => {
        const verdict = verdictOf(result);
        const on = selected === result.metric_id;
        return (
          <button
            key={result.metric_id}
            type="button"
            aria-pressed={on}
            onClick={() => onSelect(on ? null : result.metric_id)}
            className={`flex flex-col gap-2 rounded-[4px] border bg-surface px-4 py-3.5 text-left transition-colors hover:bg-surface-2 ${
              on ? "border-accent shadow-[0_0_0_1px_var(--accent)]" : "border-line"
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="text-[13px] font-medium text-ink-2">{metricName(result.metric_id, metrics)}</span>
              <ResultChip state={verdict} />
            </div>
            <span className={`text-[26px] leading-none font-bold tracking-[-0.02em] tabular-nums ${VALUE_TONE[verdict]}`}>
              {headline(result.metric_id, countsOf(result), run)}
            </span>
            <span className="text-[12px] leading-snug text-ink-3">{tileLine(result)}</span>
          </button>
        );
      })}
    </div>
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** How each kind of failed claim is labelled in the detail panel. */
const ISSUE_LABELS: Record<string, Partial<Record<MetricResult["evidence"][number]["verdict"], string>>> = {
  groundedness: { failed: "Contradicts the sources", missing: "Not in the sources" },
  correctness: { failed: "Wrong", missing: "Not in the answer key", left_out: "Left out" },
};

/** What happens to this result next, in one sentence. */
function nextStep(result: MetricResult): string {
  const state = stateOf(result);
  if (state === "could_not_run") return "Not counted: neither a pass nor a fail. It can be re-run once the check is back.";
  if (state === "missing_data") return "Not counted: the run didn’t carry the data this check needs.";
  if (state === "passed") return "Nothing to do.";
  if (isLimit(result)) return "Measured, so there is nothing to review. The question is what to do about it: fix the slow part, or raise the limit for this agent.";
  if (result.review === "auto") return "Measured, so it counts as real without a review. Record what was done about it.";
  return "Waits for a reviewer to say whether it’s real.";
}

/** The selected check, told in full: why it was flagged, the specifics, its pass rule and what happens next. */
function CheckDetail({
  result,
  run,
  highlightable,
  highlight,
  onHighlight,
}: {
  result: MetricResult;
  run: Run;
  highlightable: string[];
  highlight: Highlight;
  onHighlight: (value: Highlight) => void;
}) {
  const state = stateOf(result);
  const labels = ISSUE_LABELS[result.metric_id] ?? {};
  const issues = result.evidence.filter((e) => labels[e.verdict]);
  const shown = issues.slice(0, 4);
  const failedSteps = result.metric_id === "execution_success" ? run.steps.filter((s) => s.error) : [];
  const leaks = result.metric_id === "data_leakage" && state === "failed" ? result.evidence : [];
  const canHighlight = highlightable.includes(result.metric_id);
  const passRule = rule(result);
  const hasSpecifics = result.metric_id === "latency" || shown.length > 0 || failedSteps.length > 0 || leaks.length > 0;
  return (
    <div className="grid gap-x-8 gap-y-3 rounded-[4px] border border-line bg-surface-2 px-5 py-4 [grid-template-columns:minmax(0,1fr)] md:[grid-template-columns:minmax(0,1fr)_260px]">
      <div className="flex min-w-0 flex-col gap-3">
        {result.metric_id === "latency" ? <TimeBar run={run} bare /> : null}
        {!hasSpecifics ? <p className="m-0 text-sm text-ink-2">{readableMs(result.reason)}</p> : null}
        {shown.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {shown.map((issue, i) => {
              const look = issue.verdict === "failed" ? CLAIM_VERDICT.failed : CLAIM_VERDICT.missing;
              return (
                <li key={i} className="flex items-start gap-2 text-[13px] leading-normal">
                  <span className="mt-[2px] inline-flex h-[18px] flex-none items-center rounded px-1.5 text-[11px] font-semibold whitespace-nowrap" style={{ background: look.bg, color: look.fg }}>
                    {labels[issue.verdict]}
                  </span>
                  <span className="text-ink-2">
                    “{shorten(issue.item, 110)}”
                    {issue.verdict === "failed" && issue.source ? <> — the sources say “{shorten(issue.source, 80)}”</> : null}
                  </span>
                </li>
              );
            })}
            {issues.length > shown.length ? <li className="text-[12.5px] text-ink-3">and {issues.length - shown.length} more under What we observed</li> : null}
          </ul>
        ) : null}
        {failedSteps.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {failedSteps.map((step, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] leading-normal">
                <span className="mt-[2px] text-s-conf">
                  <Icon.Warning />
                </span>
                <span className="text-ink-2">
                  <span className="mono font-medium text-ink">{step.name}</span>: {step.error}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {leaks.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {leaks.map((leak, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] leading-normal">
                <span className="mt-[2px] text-s-conf">
                  <Icon.Warning />
                </span>
                <span className="text-ink-2">{leak.item}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <dl className="m-0 flex flex-col gap-2.5 text-[12.5px] leading-normal md:border-l md:border-line-2 md:pl-6">
        {passRule ? (
          <div>
            <dt className="font-semibold text-ink-3">Pass rule</dt>
            <dd className="m-0 text-ink-2">{capitalise(passRule)}</dd>
          </div>
        ) : null}
        <div>
          <dt className="font-semibold text-ink-3">What happens next</dt>
          <dd className="m-0 text-ink-2">{nextStep(result)}</dd>
        </div>
        {canHighlight ? (
          <dd className="m-0">
            <button
              type="button"
              onClick={() => onHighlight(highlight === result.metric_id ? "all" : result.metric_id)}
              className="h-8 rounded-lg border border-line bg-surface px-3 text-[12.5px] font-medium text-ink hover:bg-surface-2"
            >
              Show in the answer
            </button>
          </dd>
        ) : null}
      </dl>
    </div>
  );
}

// ---------- 1. What the agent saw and said ----------

type Open = Record<string, boolean>;

/** Scroll to the mark that holds this quote and light it up. Returns a function that cancels the light-up. */
function revealQuote(quote: string): (() => void) | undefined {
  const needle = quote.trim().toLowerCase();
  const mark = [...document.querySelectorAll<HTMLElement>("[data-quote]")].find((el) => (el.dataset.quote ?? "").trim().toLowerCase() === needle);
  if (!mark) return undefined;
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
  mark.classList.add("flash");
  const timer = setTimeout(() => mark.classList.remove("flash"), 1800);
  return () => {
    clearTimeout(timer);
    mark.classList.remove("flash");
  };
}

function Transcript({
  report,
  metrics,
  claims,
  leaks,
  highlight,
  highlightable,
  onHighlight,
}: {
  report: RunReport;
  metrics?: MetricInfo[];
  claims: Claim[];
  leaks: Span[];
  highlight: Highlight;
  highlightable: string[];
  onHighlight: (value: Highlight) => void;
}) {
  const { run, results } = report;
  const quotes = claims.map((c) => c.evidence.source).filter((q): q is string => !!q);
  const sources = sourcesOf(run);
  // A search whose passages the agent also sent as context: the context is shown right after that step.
  const contextAfter = run.steps.findIndex((s) => s.type !== "llm_call" && !s.error && alreadyInContext(s.output, run.context));
  const groundednessFailed = results.some((r) => r.metric_id === "groundedness" && r.passed === false);

  // Folded by default: failed steps and, when the sources are in question, the context start open.
  const [open, setOpen] = useState<Open>(() => ({
    context: groundednessFailed,
    ...Object.fromEntries(run.steps.map((s, i) => [`step-${i}`, !!s.error])),
  }));
  // A quote waiting to be revealed once the card that holds it has opened.
  const pendingQuote = useRef<string | null>(null);
  const toggle = (key: string) => setOpen((o) => ({ ...o, [key]: !o[key] }));

  /** Open whatever holds this quote and scroll to its mark. */
  const showQuote = (quote: string) => {
    const needle = quote.trim().toLowerCase();
    // The agent's instructions are a source for the judge but are never shown on the page.
    const place = sources.find((s) => !s.empty && s.label !== "Agent instructions" && s.text.toLowerCase().includes(needle));
    if (!place) return;
    const key = place.label.startsWith("Context") ? "context" : `step-${Number(place.from?.replace("step ", "")) - 1}`;
    if (open[key]) {
      revealQuote(quote);
      return;
    }
    pendingQuote.current = quote;
    setOpen((o) => ({ ...o, [key]: true }));
  };

  useEffect(() => {
    if (!pendingQuote.current) return;
    const quote = pendingQuote.current;
    pendingQuote.current = null;
    return revealQuote(quote);
  }, [open]);

  const context = run.context.length ? (
    <ContextCard run={run} quotes={quotes} retrieved={contextAfter >= 0} open={!!open.context} onToggle={() => toggle("context")} />
  ) : null;

  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-col gap-1.5 px-[18px] py-3.5">
        <span className="text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase">User</span>
        <p className="m-0 text-[15px] leading-normal whitespace-pre-wrap">{run.input}</p>
      </Card>
      {contextAfter < 0 ? context : null}
      {run.steps.map((step, i) => (
        <Fragment key={i}>
          <StepCard step={step} index={i} run={run} quotes={quotes} inContext={i === contextAfter} open={!!open[`step-${i}`]} onToggle={() => toggle(`step-${i}`)} />
          {i === contextAfter ? context : null}
        </Fragment>
      ))}
      {run.steps.length === 0 ? <p className="m-0 px-1 text-[13px] text-ink-3">The agent didn’t record any steps.</p> : null}
      <AnswerCard
        report={report}
        metrics={metrics}
        claims={claims}
        leaks={leaks}
        sources={sources}
        highlight={highlight}
        highlightable={highlightable}
        onHighlight={onHighlight}
        onShowQuote={showQuote}
      />
    </div>
  );
}

/** Where the time went, step by step, with the part no step accounts for. */
function TimeBar({ run, bare = false }: { run: Run; bare?: boolean }) {
  const steps = run.steps;
  if (!steps.some((s) => s.latency_ms != null)) return null;
  const recorded = steps.reduce((sum, s) => sum + (s.latency_ms ?? 0), 0);
  const total = run.latency_ms != null ? Math.max(run.latency_ms, recorded) : recorded;
  if (!total) return null;
  const gap = total - recorded;
  const colour = (s: Step) => (s.error ? "var(--s-conf)" : s.type === "llm_call" ? "var(--ink3)" : "var(--accent)");
  return (
    <div className={`flex flex-col gap-2 ${bare ? "" : "rounded-[4px] border border-line bg-surface px-4 py-3"}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[12.5px] text-ink-2">
        <span className="font-semibold text-ink">{bare ? "Where the time went" : "Time"}</span>
        <span>
          {bare ? "" : `${formatMs(total)} in total`}
          {gap >= 1000 ? `${bare ? "" : ", "}${formatMs(gap)} not covered by any step` : ""}
        </span>
      </div>
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-sm bg-line-2">
        {steps.map((s, i) =>
          s.latency_ms ? <span key={i} title={`${s.name}: ${formatMs(s.latency_ms)}`} style={{ width: `${(s.latency_ms / total) * 100}%`, background: colour(s) }} /> : null,
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
        {steps.map((s, i) => (
          <span key={i} className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-sm" style={{ background: colour(s) }} />
            {i + 1} {s.name}
            <span className="mono text-ink-3">{s.latency_ms != null ? formatMs(s.latency_ms) : "—"}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** A card whose header is a toggle: one line when folded, the full content when open. */
function FoldCard({
  eyebrow,
  title,
  summary,
  right,
  open,
  onToggle,
  tone = "plain",
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  summary: ReactNode;
  right?: ReactNode;
  open: boolean;
  onToggle: () => void;
  tone?: "plain" | "bad";
  children: ReactNode;
}) {
  return (
    <Card>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-[18px] py-3 text-left hover:bg-surface-2 ${open ? "border-b border-line-2" : ""}`}
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>
          <Icon.ChevronRight size={14} stroke="var(--ink3)" />
        </span>
        <span className="text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase">{eyebrow}</span>
        <span className="mono text-[13.5px] font-semibold">{title}</span>
        <span className={`min-w-0 flex-1 truncate text-[13px] ${tone === "bad" ? "font-semibold text-s-conf-fg" : "text-ink-2"}`}>{summary}</span>
        {right}
      </button>
      {open ? <div className="flex flex-col gap-2.5 px-[18px] py-3">{children}</div> : null}
    </Card>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-3 [grid-template-columns:68px_minmax(0,1fr)]">
      <span className="pt-px text-[11.5px] font-semibold tracking-[0.05em] text-ink-3 uppercase">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function marks(text: string, quotes: string[]): ReactNode {
  return highlightQuotes(text, quotes).map((part, j) =>
    part.hl ? (
      <mark key={j} data-quote={part.quote} className="rounded-[3px] bg-accent-soft px-0.5 py-px text-ink shadow-[inset_0_-2px_0_var(--accent)]">
        {part.text}
      </mark>
    ) : (
      <span key={j}>{part.text}</span>
    ),
  );
}

/** Text that folds after a few lines, with the judge's quotes marked wherever they occur. */
function Folded({ text, lines, mono = false, quotes = [] }: { text: string; lines: number; mono?: boolean; quotes?: string[] }) {
  const [open, setOpen] = useState(false);
  const all = text.split("\n");
  const long = all.length > lines + 2 || text.length > 900;
  const shown = open || !long ? text : all.length > lines + 2 ? all.slice(0, lines).join("\n") : `${text.slice(0, 900)}…`;
  return (
    <div className="flex flex-col gap-1.5">
      <pre
        className={`m-0 max-h-[520px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] ${
          mono ? "mono text-[12.5px] leading-[1.6] text-ink-2" : "font-[inherit] text-[13.5px] leading-relaxed text-ink"
        }`}
      >
        {marks(shown, quotes)}
      </pre>
      {long ? (
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="self-start text-[12.5px] font-medium text-accent hover:underline">
          {open ? "Show less" : `Show all (${all.length} lines, ${text.length.toLocaleString()} characters)`}
        </button>
      ) : null}
    </div>
  );
}

interface ToolDecision {
  tool: string;
  args: Record<string, unknown>;
}

/** A model step whose output is the tool calls it decided to make: [{"tool": ..., "args": {...}}]. */
function toolDecisions(step: Step): ToolDecision[] | null {
  if (step.type !== "llm_call" || !Array.isArray(step.output) || step.output.length === 0) return null;
  const calls = step.output.filter(
    (c): c is ToolDecision => !!c && typeof c === "object" && typeof (c as ToolDecision).tool === "string",
  );
  return calls.length === step.output.length ? calls : null;
}

/** "top_scorers (league_name: Scottish Premiership)" */
function describeCall(call: ToolDecision): string {
  const args = Object.entries(call.args ?? {})
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
  return args ? `${call.tool} (${args})` : call.tool;
}

/**
 * Older runs from the football agent recorded a label instead of the model's input ("decide what to look up")
 * and a summary instead of its output ("calls top_scorers"). Shown as one line, never as Input and Result.
 */
function isLabelledStep(step: Step): boolean {
  return step.type === "llm_call" && typeof step.input === "string" && step.input.length <= 40 && !step.input.includes("\n");
}

function isAnswerStep(step: Step, index: number, run: Run): boolean {
  return step.type === "llm_call" && index === run.steps.length - 1 && typeof step.output === "string" && step.output.trim() === run.output.trim();
}

/** One line on what a step did, for the folded view. */
function stepSummary(step: Step, index: number, run: Run, inContext: boolean): string {
  if (step.error) return `Failed: ${step.error}`;
  if (inContext) {
    const n = Array.isArray(step.output) ? step.output.length : 0;
    return `Returned ${n} passage${n === 1 ? "" : "s"}, shown below as retrieved context`;
  }
  if (isAnswerStep(step, index, run)) return "Wrote the answer, shown below";
  const decisions = toolDecisions(step);
  if (decisions) return `Decided to call ${decisions.map(describeCall).join(" and ")}`;
  if (isLabelledStep(step)) return `${step.input} · ${typeof step.output === "string" ? step.output : describeOutput(step.output)}`;
  const input = typeof step.input === "string" ? step.input : "";
  const output = describeOutput(step.output);
  if (input && output) return `${shorten(input, 60)} → returned ${output}`;
  if (output) return `Returned ${output}`;
  return input ? shorten(input, 90) : "";
}

function StepCard({
  step,
  index,
  run,
  quotes,
  inContext,
  open,
  onToggle,
}: {
  step: Step;
  index: number;
  run: Run;
  quotes: string[];
  inContext: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const error = !!step.error;
  const input = asText(step.input, true);
  const output = step.output === null || step.output === undefined || step.output === "" ? "" : asText(step.output, true);
  const isAnswer = isAnswerStep(step, index, run);
  const passages = Array.isArray(step.output) ? step.output.length : 0;
  const decisions = toolDecisions(step);
  const labelled = isLabelledStep(step);
  return (
    <FoldCard
      eyebrow={`Step ${index + 1} · ${STEP_TYPE[step.type]}`}
      title={step.name}
      summary={stepSummary(step, index, run, inContext)}
      tone={error ? "bad" : "plain"}
      right={step.latency_ms != null ? <span className={`mono text-[12.5px] ${error ? "font-semibold text-s-conf-fg" : "text-ink-2"}`}>{formatMs(step.latency_ms)}</span> : null}
      open={open}
      onToggle={onToggle}
    >
      {step.type === "llm_call" && !input ? (
        <p className="m-0 text-[12.5px] text-ink-3">The model read the question, the instructions and the results of earlier steps.</p>
      ) : null}
      {labelled ? (
        <p className="m-0 text-[13px] text-ink-2">
          The agent recorded this step as “{String(step.input)}” and “{typeof step.output === "string" ? step.output : describeOutput(step.output)}”, not the model’s
          actual input and output.
        </p>
      ) : input ? (
        <Labelled label="Input">
          <Folded text={input} lines={6} mono={typeof step.input !== "string"} />
        </Labelled>
      ) : null}
      {labelled ? null : decisions ? (
        <Labelled label="Decided">
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {decisions.map((call, i) => (
              <li key={i} className="mono text-[12.5px] text-ink">
                {describeCall(call)}
              </li>
            ))}
          </ul>
        </Labelled>
      ) : error ? (
        <Labelled label="Result">
          <span className="inline-flex items-center gap-1.5 rounded-[5px] bg-s-conf-bg px-2 py-1 text-[12.5px] font-semibold text-s-conf-fg">
            <Icon.Warning />
            Failed: {step.error}
          </span>
        </Labelled>
      ) : inContext ? (
        <Labelled label="Result">
          <span className="text-[13px] text-ink-2">
            {passages} passage{passages === 1 ? "" : "s"}, shown below as retrieved context.
          </span>
        </Labelled>
      ) : isAnswer ? (
        <Labelled label="Result">
          <span className="text-[13px] text-ink-2">The answer, shown below.</span>
        </Labelled>
      ) : output ? (
        <Labelled label="Result">
          <Folded text={output} lines={step.type === "llm_call" ? 4 : 10} mono={typeof step.output !== "string"} quotes={quotes} />
        </Labelled>
      ) : null}
    </FoldCard>
  );
}

function ContextCard({ run, quotes, retrieved, open, onToggle }: { run: Run; quotes: string[]; retrieved: boolean; open: boolean; onToggle: () => void }) {
  const quoted = run.context.filter((text) => highlightQuotes(text, quotes).some((p) => p.hl)).length;
  const n = run.context.length;
  return (
    <FoldCard
      eyebrow={retrieved ? "Retrieved context" : "Context"}
      title={`${n} passage${n === 1 ? "" : "s"}`}
      summary={quoted ? `${quoted} quoted by the judge` : retrieved ? "what the search returned" : "given to the agent"}
      right={
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-3">
          <span className="h-2.5 w-3.5 rounded-sm bg-accent-soft shadow-[inset_0_-2px_0_var(--accent)]" />
          quoted by the judge
        </span>
      }
      open={open}
      onToggle={onToggle}
    >
      {run.context.map((text, i) => (
        <div key={i} className="flex flex-col gap-1 border-b border-line-2 pb-3 last:border-b-0 last:pb-0">
          <span className="text-xs font-semibold text-ink-3">Context {i + 1}</span>
          <p className="m-0 max-h-60 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{marks(text, quotes)}</p>
        </div>
      ))}
    </FoldCard>
  );
}

// ---------- The answer, with each check's findings marked in it ----------

const VERDICT_RANK = { failed: 0, missing: 1, passed: 2 } as const;

/** The claim that decides a sentence's colour: a contradiction beats "not mentioned" beats backed. */
function worstOf(claims: Claim[]): Claim {
  return [...claims].sort((a, b) => {
    const byVerdict = VERDICT_RANK[a.evidence.verdict] - VERDICT_RANK[b.evidence.verdict];
    if (byVerdict) return byVerdict;
    // Among backed claims, one backed by a real source outranks one backed only by the agent's instructions.
    return Number(a.evidence.found_in === INSTRUCTIONS_SOURCE) - Number(b.evidence.found_in === INSTRUCTIONS_SOURCE);
  })[0];
}

function text(value: string): ReactNode {
  return boldRuns(value).map((run, i) => (run.bold ? <strong key={i}>{run.text}</strong> : <span key={i}>{run.text}</span>));
}

const LEAK_LOOK = { label: "Personal data", bg: "var(--hl-bad-bg)", fg: "var(--hl-bad-fg)", line: "var(--s-conf)" };

function AnswerCard({
  report,
  metrics,
  claims,
  leaks,
  sources,
  highlight,
  highlightable,
  onHighlight,
  onShowQuote,
}: {
  report: RunReport;
  metrics?: MetricInfo[];
  claims: Claim[];
  leaks: Span[];
  sources: Source[];
  highlight: Highlight;
  highlightable: string[];
  onHighlight: (value: Highlight) => void;
  onShowQuote: (quote: string) => void;
}) {
  const { run, results, diagnosis } = report;
  const { segments, unplaced } = placeClaims(run.output, claims);
  const [selected, setSelected] = useState<number[] | null>(null);
  const showClaims = (highlight === "all" || highlight === "groundedness") && claims.length > 0;
  const showLeaks = (highlight === "all" || highlight === "data_leakage") && leaks.length > 0;
  const grounded = results.find((r) => r.metric_id === "groundedness");
  const judgeDown = grounded?.skipped_because === "could_not_run";

  const same = (a: number[] | null, b: number[]) => a !== null && a.join() === b.join();
  const toggle = (ids: number[]) => setSelected(same(selected, ids) ? null : ids);

  const claimButton = (ids: number[], label: ReactNode, key: string | number, base?: ClaimLook) => {
    const look = base ?? claimLook(worstOf(ids.map((i) => claims[i])).evidence);
    const on = same(selected, ids);
    return (
      <button
        key={key}
        onClick={() => toggle(ids)}
        aria-pressed={on}
        aria-label={`${ids.length} claim${ids.length === 1 ? "" : "s"} checked here: ${look.label}. Show what the judge found.`}
        className="mx-px inline cursor-pointer rounded px-1 py-px text-left"
        style={{ background: look.bg, color: look.fg, boxShadow: `inset 0 -2px 0 ${look.line}${on ? ", 0 0 0 2px var(--accent)" : ""}` }}
      >
        {label}
      </button>
    );
  };

  // Leak spans are offsets into the whole answer, so each segment needs its start offset.
  const starts: number[] = [];
  let at = 0;
  for (const segment of segments) {
    starts.push(at);
    at += segment.text.length;
  }
  /** A slice of the answer with leaks and a claim's distinct words marked; plain parts keep their bold. */
  const marked = (value: string, offset: number, ranges: (Span & { look: ClaimLook })[]) => {
    const parts = markSpans(value, offset, ranges);
    let cursor = offset;
    return parts.map((part, j) => {
      const at = cursor;
      cursor += part.text.length;
      if (!part.marked) return <span key={j}>{text(part.text)}</span>;
      const look = ranges.find((r) => at >= r.start && at < r.end)?.look ?? LEAK_LOOK;
      return (
        <mark key={j} className="rounded-[3px] px-0.5 py-px" style={{ background: look.bg, color: look.fg, boxShadow: `inset 0 -2px 0 ${look.line}` }}>
          {part.text.replaceAll("**", "")}
        </mark>
      );
    });
  };

  const rendered = segments.map((segment, i) => {
    const start = starts[i];
    const ranges: (Span & { look: ClaimLook })[] = showLeaks ? leaks.map((l) => ({ ...l, look: LEAK_LOOK })) : [];
    const inSentence = segment.claims.map((c) => claims[c]);
    const good = inSentence.filter((c) => c.evidence.verdict === "passed");
    const bad = inSentence.filter((c) => c.evidence.verdict !== "passed");
    // A sentence with supported and unsupported claims: colour it as supported and mark only the words the
    // unsupported claims add ("1st" in "Camilo (Celtic, 1st)"), so the line isn't painted by its worst claim.
    let base: ClaimLook | undefined;
    if (showClaims && good.length && bad.length) {
      const spans = distinctSpans(segment.text, bad.map((c) => c.evidence.item), good.map((c) => c.evidence.item));
      if (spans.length) {
        base = claimLook(worstOf(good).evidence);
        const look = claimLook(worstOf(bad).evidence);
        ranges.push(...spans.map((s) => ({ start: s.start + start, end: s.end + start, look })));
      }
    }
    const inner = ranges.length ? marked(segment.text, start, ranges) : text(segment.text);
    return showClaims && segment.claims.length ? claimButton(segment.claims, inner, i, base) : <span key={i}>{inner}</span>;
  });

  const legend = [
    ...(showClaims && claims.some((c) => c.evidence.verdict === "passed" && c.evidence.found_in === INSTRUCTIONS_SOURCE)
      ? [claimLook({ verdict: "passed", found_in: INSTRUCTIONS_SOURCE })]
      : []),
    ...(showClaims ? (["passed", "failed", "missing"] as const).map((v) => CLAIM_VERDICT[v]) : []),
    ...(showLeaks ? [LEAK_LOOK] : []),
  ];
  const options: [Highlight, string][] = [
    ...(highlightable.length > 1 ? ([["all", "All"]] as [Highlight, string][]) : []),
    ...highlightable.map((id): [Highlight, string] => [id, metricName(id, metrics)]),
    ["none", "None"],
  ];
  const pressed = (value: Highlight) => highlight === value || (highlight === "all" && highlightable.length === 1 && value !== "none");

  return (
    <Card className="flex flex-col gap-3.5 px-5 py-[18px]" id="answer">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase">Agent</span>
        {highlightable.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]" role="group" aria-label="Highlight findings in the answer">
            <span className="mr-1 text-ink-3">Highlight</span>
            {options.map(([value, label]) => (
              <button
                key={value}
                onClick={() => onHighlight(value)}
                aria-pressed={pressed(value)}
                className={`h-7 rounded-full border px-2.5 font-medium ${pressed(value) ? "border-ink bg-ink text-canvas" : "border-line text-ink-2 hover:bg-surface-2"}`}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <p className="m-0 text-[17px] leading-[1.7] whitespace-pre-wrap">{rendered}</p>
      {showClaims && unplaced.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold text-ink-3">Claims the judge checked that don’t match one sentence</span>
          <span className="flex flex-wrap gap-2 text-[14px]">{unplaced.map((c) => claimButton([c.index], c.evidence.item, `u${c.index}`))}</span>
        </div>
      ) : null}

      {selected && showClaims ? <ClaimDetails claims={selected.map((i) => claims[i])} sources={sources} diagnosis={diagnosis} onShowQuote={onShowQuote} /> : null}

      {legend.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1.5 text-[12.5px] text-ink-2">
          {legend.map((look) => (
            <span key={look.label} className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-3.5 rounded-sm" style={{ background: look.bg, boxShadow: `inset 0 -2px 0 ${look.line}` }} />
              {look.label}
            </span>
          ))}
          {showClaims ? <span className="text-ink-3">Select a sentence to see what the judge found in it.</span> : null}
        </div>
      ) : null}
      {judgeDown ? <div className="text-[13px] text-ink-3">Claims weren’t checked: the AI judge couldn’t run.</div> : null}
      {run.expected_output ? (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5 border-t border-line-2 pt-3.5">
          <span className="text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase">Answer key</span>
          <span className="text-[15px]">{run.expected_output}</span>
        </div>
      ) : null}
    </Card>
  );
}

function ClaimDetails({
  claims,
  sources,
  diagnosis,
  onShowQuote,
}: {
  claims: Claim[];
  sources: Source[];
  diagnosis: Diagnosis | null;
  onShowQuote: (quote: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 px-4 py-3.5">
      {claims.map((claim) => {
        const look = claimLook(claim.evidence);
        const second = diagnosis?.second_opinions.find((s) => s.claim === claim.evidence.item);
        const quote = claim.evidence.source;
        const inSources = !!quote && sources.some((s) => !s.empty && s.label !== "Agent instructions" && s.text.toLowerCase().includes(quote.trim().toLowerCase()));
        // What our code found about the quote, as recorded in the diagnosis (claims are numbered from 1 there).
        const check = diagnosis?.observations.find(
          (o) => o.id === `groundedness-claim-${claim.index + 1}-quote-found` || o.id === `groundedness-claim-${claim.index + 1}-quote-not-found`,
        );
        return (
          <div key={claim.index} className="flex flex-col gap-2 border-t border-line-2 pt-3 first:border-t-0 first:pt-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex h-6 items-center rounded-full px-[9px] text-xs font-semibold" style={{ background: look.bg, color: look.fg }}>
                {look.label}
              </span>
              <JudgeBadge />
            </div>
            <div className="text-[14.5px] leading-normal font-medium">“{claim.evidence.item}”</div>
            {quote ? (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13.5px] leading-normal text-ink-2">
                <span>
                  The judge quoted: <span className="text-ink">“{quote}”</span>
                </span>
                {inSources ? (
                  <button type="button" onClick={() => onShowQuote(quote)} className="text-[12.5px] font-medium text-accent hover:underline">
                    Show it in the sources
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="text-[13.5px] text-ink-2">
                {claim.evidence.verdict === "missing" ? "The judge found nothing about this in the sources, so there is no quote." : "The judge gave no quote for this claim."}
              </div>
            )}
            {check ? (
              <div className="text-[13px] leading-normal text-ink-2">
                <span className="font-semibold text-ink">Code: </span>
                {quoteCheck(check, "the sources").text}
              </div>
            ) : null}
            {claim.evidence.note ? <div className="text-[13px] leading-normal text-ink-3">{claim.evidence.note}</div> : null}
            {second ? (
              <div className="text-[13px] leading-normal text-ink-2">
                A second AI judge re-checked this claim and {second.agreed ? "agrees" : "disagrees"}: {second.verdict.replace("_", " ")}.
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
