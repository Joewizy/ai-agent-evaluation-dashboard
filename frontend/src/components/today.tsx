"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api, type ReviewCount, type RunStatus, type Summary } from "@/lib/api";
import { patternLabel, STATUS, STATUS_ORDER } from "@/lib/labels";
import { daysAgo, formatTime, isWindow, sinceOf, type Window, windowNoun, WINDOWS } from "@/lib/time";
import { useResource } from "@/lib/use-resource";
import { Card, CardTitle, ErrorNote, LiveNote, Loading, MethodBadge, PageTitle, Select, STATUS_FILL } from "./ui";

const TRUST_DAYS = 30;

function runsHref(status: RunStatus | "all", window: Window) {
  const params = new URLSearchParams({ status });
  if (window !== "today") params.set("since", window);
  return `/runs?${params}`;
}

export function TodayView() {
  const router = useRouter();
  const params = useSearchParams();
  const raw = params.get("since");
  const window: Window = isWindow(raw) ? raw : "today";

  // The Today page polls while it's open; the trust numbers and metric list don't change minute to minute.
  const summary = useResource(`summary:${window}`, () => api.summary({ since: sinceOf(window) }), () => true);
  const trust = useResource("summary:trust", () => api.summary({ since: daysAgo(TRUST_DAYS) }));
  const metrics = useResource("metrics", api.metrics);

  const setWindow = (value: string) => router.replace(value === "today" ? "/" : `/?since=${value}`);

  return (
    <main className="mx-auto flex max-w-[1620px] flex-col gap-5 px-8 pt-7 pb-[72px]">
      <PageTitle title={window === "today" ? "Today" : "Overview"} sub="What ran, what broke, and what is waiting on a person.">
        <LiveNote updatedAt={summary.updatedAt} />
        <Select id="since-today" label="Showing" value={window} onChange={(e) => setWindow(e.target.value)}>
          {WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </Select>
      </PageTitle>

      {summary.error ? <ErrorNote error={summary.error} onRetry={summary.refresh} /> : null}
      {!summary.data ? (
        summary.error ? null : <Loading />
      ) : (
        <>
          <Tiles summary={summary.data} window={window} />
          <StatusBar summary={summary.data} window={window} />
          {/* Grid items stretch, so these two cards are always the same height side by side. */}
          <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(min(460px,100%),1fr))]">
            <Causes summary={summary.data} window={window} />
            <Actions summary={summary.data} window={window} updatedAt={summary.updatedAt} />
          </div>
          <Checks summary={summary.data} methods={metrics.data} />
          {/* Grid items stretch, so these two cards are always the same height side by side. */}
          <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(min(460px,100%),1fr))]">
            <Trust summary={trust.data} />
            <Agents summary={summary.data} />
          </div>
        </>
      )}
    </main>
  );
}

function count(summary: Summary, status: RunStatus) {
  return summary.by_status[status] ?? 0;
}

function Tiles({ summary, window }: { summary: Summary; window: Window }) {
  const evaluating = count(summary, "evaluating");
  const falseAlarms = count(summary, "false_alarm");
  const confirmed = count(summary, "confirmed");
  const needs = summary.pending_reviews;
  const tiles: { label: string; n: number; sub: string; status: RunStatus | "all"; highlight?: boolean }[] = [
    {
      label: window === "today" ? "Runs today" : "Runs",
      n: summary.runs,
      sub: evaluating ? `${evaluating} still being scored` : "All scored",
      status: "all",
    },
    {
      label: "Failed runs",
      n: summary.failed_runs,
      sub: falseAlarms ? `${falseAlarms} later ruled a false alarm` : "None ruled a false alarm",
      status: "all",
    },
    {
      label: "Needs review",
      n: needs,
      sub: needs ? "Waiting on a person. Review now" : "Nothing waiting on you",
      status: "needs_review",
      highlight: needs > 0,
    },
    {
      label: "Resolved",
      n: count(summary, "resolved"),
      sub: confirmed ? `${confirmed} confirmed, waiting for an action` : "Action recorded",
      status: confirmed ? "confirmed" : "resolved",
    },
    { label: "Couldn’t be checked", n: count(summary, "could_not_run"), sub: "Not a pass and not a fail", status: "could_not_run" },
  ];
  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))]">
      {tiles.map((tile) => (
        <Link
          key={tile.label}
          href={runsHref(tile.status, window)}
          className={`flex min-h-[126px] flex-col items-start gap-2.5 rounded-[10px] border px-[18px] py-4 text-left no-underline ${
            tile.highlight
              ? "border-s-need bg-s-need-bg text-s-need-fg hover:border-s-need-fg"
              : "border-line bg-surface hover:border-ink-3"
          }`}
        >
          <span className={`text-[13px] font-medium ${tile.highlight ? "" : "text-ink-2"}`}>{tile.label}</span>
          <span className={`text-4xl leading-none font-bold tracking-[-0.03em] ${tile.highlight ? "" : "text-ink"}`}>{tile.n}</span>
          <span className={`text-[12.5px] leading-snug ${tile.highlight ? "" : "text-ink-3"}`}>{tile.sub}</span>
        </Link>
      ))}
    </div>
  );
}

function StatusBar({ summary, window }: { summary: Summary; window: Window }) {
  const present = STATUS_ORDER.filter((s) => count(summary, s) > 0);
  const aria = "Runs by status: " + STATUS_ORDER.map((s) => `${STATUS[s].label} ${count(summary, s)}`).join(", ");
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-[15px] font-semibold">Runs by status</h2>
        <span className="text-[13px] text-ink-3">
          {summary.runs} runs {windowNoun(window)}
        </span>
      </div>
      <div className="flex h-7 gap-0.5 overflow-hidden rounded bg-surface-2" role="img" aria-label={aria}>
        {present.map((s) => (
          <div
            key={s}
            title={`${STATUS[s].label}: ${count(summary, s)}`}
            className="min-w-2"
            style={{ flex: `${count(summary, s)} 1 0`, background: STATUS_FILL[STATUS[s].key] }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-1.5 gap-y-1">
        {STATUS_ORDER.map((s) => (
          <Link
            key={s}
            href={runsHref(s, window)}
            className="inline-flex min-h-9 items-center gap-2 rounded-md px-2.5 text-[13px] text-ink-2 no-underline hover:bg-surface-2"
          >
            <span className="size-3 flex-none rounded-[3px]" style={{ background: STATUS_FILL[STATUS[s].key] }} />
            <span>{STATUS[s].label}</span>
            <span className="font-bold text-ink">{count(summary, s)}</span>
          </Link>
        ))}
      </div>
    </Card>
  );
}

function Causes({ summary, window }: { summary: Summary; window: Window }) {
  const entries = Object.entries(summary.failures_by_cause).sort(([a, x], [b, y]) => {
    if (a === "no_explanation") return 1;
    if (b === "no_explanation") return -1;
    return y - x;
  });
  const max = Math.max(1, ...entries.map(([, n]) => n));
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  const several = summary.runs_with_several_causes;
  return (
    <Card className="flex flex-col gap-4 p-5">
      <CardTitle title={window === "today" ? "Possible causes of today’s failures" : "Possible causes of failures"} sub="Runs where this was a possible cause" />
      {entries.length === 0 ? (
        <p className="m-0 text-[13.5px] text-ink-3">No failures {windowNoun(window)}.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {entries.map(([pattern, n]) => (
            <li key={pattern} className="grid items-center gap-3 text-[13.5px] [grid-template-columns:minmax(150px,210px)_minmax(0,1fr)_28px]">
              <span>{patternLabel(pattern)}</span>
              <span title={`${patternLabel(pattern)}: possible cause in ${n} runs`} className="flex h-[18px] rounded bg-surface-2">
                <span
                  className="h-full rounded"
                  style={{ width: `${(n / max) * 100}%`, background: pattern === "no_explanation" ? "var(--ink3)" : "var(--accent)" }}
                />
              </span>
              <span className="text-right font-bold">{n}</span>
            </li>
          ))}
        </ul>
      )}
      {summary.failed_runs > 0 ? (
        <p className="m-0 border-t border-line-2 pt-3 text-[13px] leading-normal text-ink-2">
          {several > 0
            ? `${several} of ${summary.failed_runs} failed runs have more than one possible cause, so these add up to ${total}, not ${summary.failed_runs}.`
            : `Each of the ${summary.failed_runs} failed runs has one possible cause.`}
        </p>
      ) : null}
    </Card>
  );
}

function Actions({ summary, window, updatedAt }: { summary: Summary; window: Window; updatedAt?: Date }) {
  const today = updatedAt ?? new Date(summary.since);
  return (
    <Card className="flex flex-col gap-3 p-5">
      <CardTitle title={window === "today" ? "Actions taken today" : "Actions taken"} sub="What people did about confirmed failures" />
      {summary.actions.length === 0 ? (
        <p className="m-0 text-[13.5px] text-ink-3">No actions recorded yet {window === "today" ? "today" : windowNoun(window)}.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {summary.actions.map((action) => (
            <li key={action.run_id} className="border-t border-line-2">
              <Link
                href={`/runs/${action.run_id}`}
                className="grid w-full gap-x-3 gap-y-1 rounded-md px-2 py-3 text-left text-ink no-underline hover:bg-surface-2 [grid-template-columns:52px_minmax(0,1fr)]"
              >
                <span className="mono pt-0.5 text-[12.5px] text-ink-3">{formatTime(action.resolved_at, today)}</span>
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm leading-[1.45] font-medium">{action.action}</span>
                  <span className="text-[12.5px] text-ink-3">
                    {action.agent_name} · by {action.resolved_by}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const CHECK_COLUMNS = "[grid-template-columns:minmax(170px,1.5fr)_minmax(190px,1.5fr)_90px_80px_100px_110px_110px]";

function Checks({ summary, methods }: { summary: Summary; methods?: { id: string; method: "code" | "llm_judge"; judge_model: string | null }[] }) {
  const rows = Object.entries(summary.metrics);
  return (
    <Card className="flex flex-col gap-3 px-5 pt-5 pb-2">
      <CardTitle
        title="Checks"
        sub="Averages count only runs that were checked. Runs where a check couldn’t run or had no data are left out: they are neither pass nor fail."
      />
      <div className="overflow-x-auto">
        <div className="min-w-[880px] text-[13.5px]">
          <div className={`grid gap-3 border-b border-line px-1 py-2.5 text-xs font-semibold text-ink-3 ${CHECK_COLUMNS}`}>
            <span>Check</span>
            <span>How it’s checked</span>
            <span className="text-right">Runs scored</span>
            <span className="text-right">Failed</span>
            <span className="text-right">Average score</span>
            <span className="text-right">Couldn’t run</span>
            <span className="text-right">No data</span>
          </div>
          {rows.length === 0 ? <p className="m-0 px-1 py-4 text-ink-3">No runs yet.</p> : null}
          {rows.map(([id, metric]) => {
            const info = methods?.find((m) => m.id === id);
            return (
              <div key={id} className={`grid items-center gap-3 border-b border-line-2 px-1 py-3 ${CHECK_COLUMNS}`}>
                <span className="font-medium">{metric.name}</span>
                <span>{info ? <MethodBadge method={info.method} model={info.judge_model} codeLabel="Code" /> : null}</span>
                <span className="text-right">{metric.scored}</span>
                <span className="text-right font-bold">{metric.failed}</span>
                <span className="text-right">{metric.average_score === null ? "—" : metric.average_score.toFixed(2)}</span>
                <span className="text-right text-ink-3">{metric.could_not_run || "—"}</span>
                <span className="text-right text-ink-3">{metric.missing_data || "—"}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

function Agreement({ label, counts, unit = "" }: { label: string; counts: ReviewCount; unit?: string }) {
  const decided = counts.correct + counts.incorrect;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] text-ink-2">{label}</span>
      {decided === 0 ? (
        <span className="text-sm text-ink-3">No reviews yet</span>
      ) : (
        <>
          <span className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tracking-[-0.02em]">
              {counts.correct} of {decided}
              {unit}
            </span>
            <span className="text-sm text-ink-2">({Math.round((counts.correct / decided) * 100)}%)</span>
          </span>
          <span className="flex h-1.5 rounded-[3px] bg-surface-2">
            <span className="h-full rounded-[3px] bg-accent" style={{ width: `${(counts.correct / decided) * 100}%` }} />
          </span>
        </>
      )}
    </div>
  );
}

function Trust({ summary }: { summary?: Summary }) {
  const empty =
    summary &&
    summary.judge_vs_humans.correct + summary.judge_vs_humans.incorrect + summary.explanations_reviewed.correct + summary.explanations_reviewed.incorrect === 0;
  return (
    <Card className="flex flex-col gap-[18px] p-5">
      <CardTitle title="How often reviewers agree with us" sub={`Last ${TRUST_DAYS} days. “Not sure” answers aren’t counted.`} />
      {!summary ? (
        <p className="m-0 text-sm text-ink-3">Loading…</p>
      ) : empty ? (
        <p className="m-0 rounded-lg bg-surface-2 p-4 text-sm text-ink-2">
          Not enough reviews yet to say how often the judge or the explanations are right.
        </p>
      ) : (
        <>
          <Agreement label="Judge agreed with reviewers" counts={summary.judge_vs_humans} unit=" times" />
          <Agreement label="Explanations found useful" counts={summary.explanations_reviewed} />
        </>
      )}
    </Card>
  );
}

function Agents({ summary }: { summary: Summary }) {
  const agents = Object.entries(summary.by_agent).sort(([, a], [, b]) => b.runs - a.runs);
  const columns = "[grid-template-columns:minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]";
  return (
    <Card className="flex flex-col gap-2 px-5 pt-5 pb-2">
      <h2 className="m-0 mb-1 text-[15px] font-semibold">By agent</h2>
      <div className="text-[13.5px]">
        <div className={`grid gap-3 border-b border-line px-1 py-2 text-xs font-semibold text-ink-3 ${columns}`}>
          <span>Agent</span>
          <span className="text-right">Runs</span>
          <span className="text-right">Failed</span>
          <span className="text-right">Couldn’t be checked</span>
        </div>
        {agents.length === 0 ? <p className="m-0 px-1 py-4 text-ink-3">No runs yet.</p> : null}
        {agents.map(([name, agent]) => (
          <Link
            key={name}
            href={`/runs?status=all&agent=${encodeURIComponent(name)}`}
            className={`grid gap-3 border-b border-line-2 px-1 py-[11px] text-ink no-underline hover:bg-surface-2 ${columns}`}
          >
            <span className={`mono text-[13px] ${name ? "" : "text-ink-3"}`}>{name || "unnamed agent"}</span>
            <span className="text-right">{agent.runs}</span>
            <span className="text-right font-bold">{agent.failed}</span>
            <span className="text-right text-ink-3">{agent.could_not_run}</span>
          </Link>
        ))}
      </div>
    </Card>
  );
}
