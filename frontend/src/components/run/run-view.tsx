"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { type ReactNode, useState } from "react";
import { api, type Diagnosis, type MetricInfo, type MetricResult, type RunReport } from "@/lib/api";
import { announceChange } from "@/lib/browser-state";
import { CLAIM_VERDICT, claimLook, INSTRUCTIONS_SOURCE, metricName, STEP_TYPE } from "@/lib/labels";
import {
  asText,
  boldRuns,
  type Claim,
  claimsOf,
  describeOutput,
  firstSentence,
  highlight,
  placeClaims,
  shorten,
  type Source,
  sourcesOf,
  whereQuoted,
} from "@/lib/run-text";
import { formatMs, formatTime } from "@/lib/time";
import { useResource } from "@/lib/use-resource";
import { Card, ErrorNote, Icon, JudgeBadge, Loading, MethodBadge, ResultChip, StatusChip } from "../ui";
import { Evidence, quoteCheck } from "./run-evidence";
import { ReviewRail } from "./run-review";
import { Section, SPINE } from "./section";

/** The lineage, read top to bottom. The question is the page title; the review sits beside it. */
const SECTIONS = [
  ["sec-did", "What the agent did"],
  ["sec-answer", "Answer"],
  ["sec-failed", "What failed"],
  ["sec-observed", "What we observed"],
  ["sec-explain", "Possible explanations"],
] as const;

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

/** One line that says where the run stands, e.g. "2 of 5 checks failed: Backed by sources, Speed." */
function verdictLine(report: RunReport, metrics?: MetricInfo[]): string {
  const { status, results, resolution } = report;
  if (status === "evaluating") return "Being scored. This usually takes under a minute.";
  const scored = results.filter((r) => r.passed !== null);
  const failed = scored.filter((r) => r.passed === false);
  const couldNotRun = results.filter((r) => r.skipped_because === "could_not_run");
  const names = (list: MetricResult[]) => list.map((r) => metricName(r.metric_id, metrics)).join(", ");
  if (failed.length) {
    const base = `${failed.length} of ${scored.length} checks failed: ${names(failed)}.`;
    if (status === "resolved" && resolution) return `${base} Resolved: ${resolution.action}`;
    if (status === "false_alarm") return `${base} Reviewers ruled every failure a false alarm.`;
    if (status === "confirmed") return `${base} Confirmed, waiting for an action.`;
    return base;
  }
  if (couldNotRun.length) return `Nothing failed, but ${names(couldNotRun)} couldn’t run, so this isn’t a pass.`;
  return `All ${scored.length} checks passed.`;
}

function RunPage({ report, metrics, now, onChanged }: { report: RunReport; metrics?: MetricInfo[]; now: Date; onChanged: () => void }) {
  const { run, status, results, diagnosis } = report;
  const failed = results.some((r) => r.passed === false);
  const evaluating = status === "evaluating";

  const meta = [
    formatTime(run.received_at, now),
    run.latency_ms != null ? formatMs(run.latency_ms) : null,
    run.tokens != null ? `${run.tokens.toLocaleString()} tokens` : null,
    run.cost_usd != null ? `$${run.cost_usd.toFixed(4)}` : null,
    run.model ?? null,
  ].filter((m): m is string => !!m);

  return (
    <Shell id={run.id}>
      <Card className="flex flex-col gap-3 px-6 py-5">
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
        <h1 className="m-0 text-[22px] leading-snug font-semibold tracking-[-0.01em]">{run.input}</h1>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className={`m-0 text-[15px] leading-normal ${failed && status !== "resolved" ? "font-medium text-s-conf-fg" : "text-ink-2"}`}>
            {verdictLine(report, metrics)}
          </p>
          {status === "needs_review" ? (
            <a href="#review" className="inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink no-underline hover:opacity-90 min-[1200px]:hidden">
              Review this run
            </a>
          ) : null}
        </div>
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
          <Section n={1} id="sec-did" title="What the agent did">
            <AgentDid report={report} />
          </Section>

          <Section n={2} id="sec-answer" title="Answer">
            <Answer report={report} />
          </Section>

          {evaluating ? (
            <Section n={3} id="sec-failed" title="What failed" last>
              <Card className="flex items-center gap-3 px-5 py-4 text-sm text-ink-2">
                <span className="size-2 animate-pulse-dot rounded-full bg-s-eval" />
                Scoring this run. This usually takes under a minute, and this page updates on its own.
              </Card>
            </Section>
          ) : (
            <>
              <Section n={3} id="sec-failed" title="What failed">
                <Results results={results} metrics={metrics} />
              </Section>
              <Evidence report={report} failed={failed} metrics={metrics} />
            </>
          )}
          {diagnosis === null && !evaluating ? (
            <p className="m-0 text-[13px] text-ink-3">This run was stored before diagnosis existed, so it has no observations or explanations.</p>
          ) : null}
        </div>

        {/* The same eyebrow as a section, so the review card lines up with the Steps and Sources cards. */}
        <aside id="review" className="rail scroll-mt-4">
          <h2 className="eyebrow">Review</h2>
          <ReviewRail report={report} failed={failed} metrics={metrics} now={now} onChanged={onChanged} />
        </aside>
      </div>
    </Shell>
  );
}

// ---------- 1. What the agent did ----------

function AgentDid({ report }: { report: RunReport }) {
  const { run, results } = report;
  const sources = sourcesOf(run);
  const quotes = claimsOf(results)
    .map((c) => c.evidence.source)
    .filter((q): q is string => !!q);
  const maxMs = Math.max(1, ...run.steps.map((s) => s.latency_ms ?? 0));
  const recorded = run.steps.reduce((sum, s) => sum + (s.latency_ms ?? 0), 0);
  const allTimed = run.steps.length > 0 && run.steps.every((s) => s.latency_ms != null);
  const gap = allTimed && run.latency_ms != null ? run.latency_ms - recorded : 0;
  const showGap = gap >= 1000;
  const stepsSub = [
    `${run.steps.length} step${run.steps.length === 1 ? "" : "s"}`,
    run.latency_ms != null ? (showGap ? `${formatMs(recorded)} recorded of ${formatMs(run.latency_ms)}` : formatMs(run.latency_ms)) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    // Grid items stretch, so the Steps and Sources cards are always the same height side by side.
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(400px,100%),1fr))]">
      <Card>
        <div className="flex items-baseline justify-between gap-2 border-b border-line-2 px-[18px] py-3.5">
          <span className="text-sm font-semibold">Steps</span>
          <span className="text-[12.5px] text-ink-3">{stepsSub}</span>
        </div>
        <ol className="m-0 list-none px-[18px] pt-1 pb-2">
          {run.steps.length === 0 ? <li className="py-3 text-[13px] text-ink-3">The agent didn’t record any steps.</li> : null}
          {run.steps.map((step, i) => {
            const error = !!step.error;
            const output = describeOutput(step.output);
            const input = shorten(asText(step.input), 160);
            return (
              <li key={i} className="grid gap-x-3 border-b border-line-2 py-3 [grid-template-columns:16px_minmax(0,1fr)_104px]">
                <span className={`mt-[3px] size-3 rounded-full border-2 ${error ? "border-s-conf bg-s-conf" : "border-ink-3 bg-surface"}`} />
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-xs text-ink-3">
                      Step {i + 1} · {STEP_TYPE[step.type]}
                    </span>
                    <span className="mono text-[13.5px] font-medium">{step.name}</span>
                  </div>
                  {input ? <div className="mono text-xs [overflow-wrap:anywhere] text-ink-2">{input}</div> : null}
                  {output && !error ? <div className="text-[12.5px] text-ink-2">Returned {output}</div> : null}
                  {error ? (
                    <div className="mt-0.5 inline-flex items-center gap-1.5 self-start rounded-[5px] bg-s-conf-bg px-2 py-1 text-[12.5px] font-semibold text-s-conf-fg">
                      <Icon.Warning />
                      Failed: {step.error}
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-col items-end gap-1.5 pt-0.5">
                  {step.latency_ms != null ? (
                    <>
                      <span className={`mono text-[12.5px] ${error ? "font-semibold text-s-conf-fg" : "text-ink-2"}`}>{formatMs(step.latency_ms)}</span>
                      <span className="flex h-1 w-full rounded-sm bg-line-2">
                        <span
                          className="h-full rounded-sm"
                          style={{
                            width: `${Math.max(4, Math.round((step.latency_ms / maxMs) * 100))}%`,
                            background: error ? "var(--s-conf)" : "var(--ink3)",
                          }}
                        />
                      </span>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
          {showGap ? (
            <li className="grid gap-x-3 py-3 [grid-template-columns:16px_minmax(0,1fr)_104px]">
              <span className="mt-[3px] size-3 rounded-full border-[1.5px] border-dashed border-ink-3" />
              <div className="text-[13px] leading-[1.45] text-ink-2">Not covered by any recorded step</div>
              <span className="mono text-right text-[12.5px] text-ink-2">{formatMs(gap)}</span>
            </li>
          ) : null}
        </ol>
      </Card>

      <Card>
        <div className="flex items-baseline justify-between gap-2 border-b border-line-2 px-[18px] py-3.5">
          <span className="text-sm font-semibold">Sources</span>
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-3">
            <span className="h-2.5 w-3.5 rounded-sm bg-accent-soft shadow-[inset_0_-2px_0_var(--accent)]" />
            Quoted by the judge
          </span>
        </div>
        {sources.length === 0 ? <p className="m-0 px-[18px] py-3.5 text-[13px] text-ink-3">The agent had no sources: no context and no tool or search results.</p> : null}
        {sources.map((source, i) => (
          <div key={i} className="flex flex-col gap-1.5 border-b border-line-2 px-[18px] py-3.5 last:border-b-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-xs font-semibold text-ink-3">{source.label}</span>
              {source.title ? <span className="mono text-[13px] font-semibold">{source.title}</span> : null}
              {source.from ? <span className="text-xs text-ink-3">from {source.from}</span> : null}
            </div>
            <p className={`m-0 max-h-72 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] ${source.empty ? "text-ink-3" : "text-ink"}`}>
              {source.empty
                ? source.text
                : highlight(source.text, quotes).map((part, j) =>
                    part.hl ? (
                      <mark key={j} className="rounded-[3px] bg-accent-soft px-0.5 py-px text-ink shadow-[inset_0_-2px_0_var(--accent)]">
                        {part.text}
                      </mark>
                    ) : (
                      <span key={j}>{part.text}</span>
                    ),
                  )}
            </p>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ---------- 2. Answer ----------

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

function Answer({ report }: { report: RunReport }) {
  const { run, results, diagnosis } = report;
  const claims = claimsOf(results);
  const { segments, unplaced } = placeClaims(run.output, claims);
  const [selected, setSelected] = useState<number[] | null>(null);
  const grounded = results.find((r) => r.metric_id === "groundedness");
  const judgeDown = grounded?.skipped_because === "could_not_run";
  const sources = sourcesOf(run);

  const same = (a: number[] | null, b: number[]) => a !== null && a.join() === b.join();
  const toggle = (ids: number[]) => setSelected(same(selected, ids) ? null : ids);

  const claimButton = (ids: number[], label: ReactNode, key: string | number) => {
    const look = claimLook(worstOf(ids.map((i) => claims[i])).evidence);
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

  const legend = [
    ...(claims.some((c) => c.evidence.verdict === "passed" && c.evidence.found_in === INSTRUCTIONS_SOURCE)
      ? [claimLook({ verdict: "passed", found_in: INSTRUCTIONS_SOURCE })]
      : []),
    ...(["passed", "failed", "missing"] as const).map((v) => CLAIM_VERDICT[v]),
  ];

  return (
    <Card className="flex flex-col gap-3.5 px-5 py-[18px]">
      <p className="m-0 text-[17px] leading-[1.7] whitespace-pre-wrap">
        {segments.map((segment, i) => (segment.claims.length === 0 ? <span key={i}>{text(segment.text)}</span> : claimButton(segment.claims, text(segment.text), i)))}
      </p>
      {unplaced.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold text-ink-3">Claims the judge checked that don’t match one sentence</span>
          <span className="flex flex-wrap gap-2 text-[14px]">{unplaced.map((c) => claimButton([c.index], c.evidence.item, `u${c.index}`))}</span>
        </div>
      ) : null}

      {selected ? <ClaimDetails claims={selected.map((i) => claims[i])} sources={sources} diagnosis={diagnosis} /> : null}

      {claims.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1.5 text-[12.5px] text-ink-2">
          {legend.map((look) => (
            <span key={look.label} className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-3.5 rounded-sm" style={{ background: look.bg, boxShadow: `inset 0 -2px 0 ${look.line}` }} />
              {look.label}
            </span>
          ))}
          <span className="text-ink-3">Select a sentence to see the claims the judge checked in it.</span>
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

function ClaimDetails({ claims, sources, diagnosis }: { claims: Claim[]; sources: Source[]; diagnosis: Diagnosis | null }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 px-4 py-3.5">
      {claims.map((claim) => {
        const look = claimLook(claim.evidence);
        const second = diagnosis?.second_opinions.find((s) => s.claim === claim.evidence.item);
        const where = claim.evidence.source ? whereQuoted(claim.evidence.source, sources) : null;
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
              <JudgeBadge model={claim.judgeModel} />
            </div>
            <div className="text-[14.5px] leading-normal font-medium">“{claim.evidence.item}”</div>
            {claim.evidence.source ? (
              <div className="text-[13.5px] leading-normal text-ink-2">
                The judge quoted{where && !check ? ` (${where})` : ""}: <span className="text-ink">“{claim.evidence.source}”</span>
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
                <span className="mono">{second.model}</span> re-checked this claim and {second.agreed ? "agrees" : "disagrees"}: {second.verdict.replace("_", " ")}.
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ---------- 3. What failed ----------

type ResultState = "failed" | "passed" | "could_not_run" | "missing_data";

function stateOf(result: MetricResult): ResultState {
  if (result.passed === false) return "failed";
  if (result.passed === true) return "passed";
  return result.skipped_because === "could_not_run" ? "could_not_run" : "missing_data";
}

const RANK: Record<ResultState, number> = { failed: 0, passed: 1, could_not_run: 2, missing_data: 3 };

/** How each kind of failed claim is labelled on a judge metric's card. */
const ISSUE_LABELS: Record<string, Partial<Record<MetricResult["evidence"][number]["verdict"], string>>> = {
  groundedness: { failed: "Contradicts the sources", missing: "Not in the sources" },
  correctness: { failed: "Wrong", missing: "Not in the answer key", left_out: "Left out" },
};

function Results({ results, metrics }: { results: MetricResult[]; metrics?: MetricInfo[] }) {
  const failed = results.filter((r) => r.passed === false);
  const others = results.filter((r) => r.passed !== false).sort((a, b) => RANK[stateOf(a)] - RANK[stateOf(b)]);
  return (
    <div className="flex flex-col gap-3">
      {failed.length > 0 ? (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr))]">
          {failed.map((result) => (
            <FailedCard key={result.metric_id} result={result} metrics={metrics} />
          ))}
        </div>
      ) : null}
      <Card className="flex flex-wrap items-center gap-2 px-4 py-3">
        <span className="mr-1 text-[12.5px] font-semibold text-ink-3">{failed.length ? "Also checked" : "Checked"}</span>
        {others.map((result) => {
          const state = stateOf(result);
          const name = metricName(result.metric_id, metrics);
          return state === "passed" ? (
            <span key={result.metric_id} title={result.reason} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[13px]">
              <span className="text-s-pass">
                <Icon.Check size={13} />
              </span>
              <span className="font-medium">{name}</span>
              <span className="text-ink-3">{result.score?.toFixed(2)}</span>
            </span>
          ) : (
            <span key={result.metric_id} title={result.reason} className="inline-flex h-8 items-center gap-2 rounded-lg border border-dashed border-line px-2.5 text-[13px] text-ink-2">
              <span className="font-medium">{name}</span>
              <ResultChip state={state} />
            </span>
          );
        })}
        {failed.length === 0 ? <span className="text-[13px] text-ink-2">Nothing failed.</span> : null}
      </Card>
    </div>
  );
}

function FailedCard({ result, metrics }: { result: MetricResult; metrics?: MetricInfo[] }) {
  const labels = ISSUE_LABELS[result.metric_id] ?? {};
  const issues = result.evidence.filter((e) => labels[e.verdict]);
  const shown = issues.slice(0, 5);
  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-s-conf bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <span className="text-[15px] font-semibold">{metricName(result.metric_id, metrics)}</span>
          {result.score !== null ? <span className="text-[22px] leading-none font-bold tracking-[-0.02em] text-s-conf-fg">{result.score.toFixed(2)}</span> : null}
        </div>
        <ResultChip state="failed" />
      </div>
      <p className="m-0 text-sm leading-normal">{issues.length ? firstSentence(result.reason) : result.reason}</p>
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
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        <MethodBadge method={result.method} model={result.judge_model} />
        {result.review === "auto" ? <span className="text-[12.5px] text-ink-3">Measured, so it counts as real without a review</span> : null}
      </div>
    </div>
  );
}
