"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api, type MetricInfo, type RunRow, type RunStatus, type Summary } from "@/lib/api";
import { metricName, patternLabel, STATUS, STATUS_ORDER } from "@/lib/labels";
import { metricOrder } from "@/lib/metrics";
import { DEFAULT_WINDOW, daysAgo, formatTime, isWindow, sinceOf, type Window, windowNoun, WINDOWS } from "@/lib/time";
import { useResource } from "@/lib/use-resource";
import { Card, CardTitle, ErrorNote, Icon, LiveNote, Loading, PageTitle, Select, STATUS_FILL } from "./ui";

const TRUST_DAYS = 30;
const ACTIONS_SHOWN = 4;

/** One line under each check's name in the Checks table. */
const CHECK_NOTE: Record<string, string> = {
  groundedness: "Claims supported by what the agent looked up",
  correctness: "Test answer matches the answer key",
  data_leakage: "No personal data in the answer",
  execution_success: "Every step completed without an error",
  latency: "Finished within the time limit",
  cost: "Stayed within the cost limit",
};

function runsHref(status: RunStatus | "all", window: Window, agent = "") {
  const params = new URLSearchParams({ status });
  if (window !== DEFAULT_WINDOW) params.set("since", window);
  if (agent) params.set("agent", agent);
  return `/runs?${params}`;
}

export function TodayView() {
  const router = useRouter();
  const params = useSearchParams();
  const raw = params.get("since");
  const window: Window = isWindow(raw) ? raw : DEFAULT_WINDOW;
  const agent = params.get("agent") ?? "";

  // The summary polls while the page is open; the history and metric list are fetched once.
  const summary = useResource(`summary:${window}:${agent}`, () => api.summary({ since: sinceOf(window), agent: agent || undefined }), () => true);
  const trust = useResource(`summary:trust:${agent}`, () => api.summary({ since: daysAgo(TRUST_DAYS), agent: agent || undefined }));
  const history = useResource(`runs:history:${agent}`, () => api.runs({ since: daysAgo(TRUST_DAYS * 2), agent: agent || undefined }));
  const agents = useResource("summary:agents", () => api.summary({ since: daysAgo(TRUST_DAYS) }));
  const metrics = useResource("metrics", api.metrics);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    const query = next.toString();
    router.replace(query ? `/?${query}` : "/");
  };

  const agentNames = Object.keys(agents.data?.by_agent ?? {}).sort();
  // From the client-side fetch time, so the server and the browser never render different dates.
  const dateLine = summary.updatedAt?.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <main className="mx-auto flex max-w-[1280px] flex-col gap-4 px-8 pt-8 pb-10">
      <PageTitle
        eyebrow={dateLine}
        title="Overview"
        sub={`Finished agent runs ${windowNoun(window)}, and the work waiting for review.`}
      >
        <Select id="since-today" label="Showing" value={window} onChange={(e) => setParam("since", e.target.value === DEFAULT_WINDOW ? null : e.target.value)}>
          {WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </Select>
        <Select id="agent-today" label="Agent" value={agent} onChange={(e) => setParam("agent", e.target.value || null)}>
          <option value="">All agents</option>
          {agentNames.map((name) => (
            <option key={name} value={name}>
              {name || "unnamed agent"}
            </option>
          ))}
        </Select>
        <LiveNote updatedAt={summary.updatedAt} />
      </PageTitle>

      {summary.error ? <ErrorNote error={summary.error} onRetry={summary.refresh} /> : null}
      {!summary.data ? (
        summary.error ? null : <Loading />
      ) : (
        <>
          <Tiles summary={summary.data} window={window} agent={agent} />
          <div className="grid gap-4 [grid-template-columns:minmax(0,1fr)] lg:[grid-template-columns:minmax(0,1.55fr)_minmax(0,1fr)]">
            <StatusPanel summary={summary.data} window={window} agent={agent} />
            <Causes summary={summary.data} window={window} />
          </div>
          <Checks summary={summary.data} metrics={metrics.data} />
          <div className="grid gap-4 [grid-template-columns:minmax(0,1fr)] lg:[grid-template-columns:minmax(0,1.55fr)_minmax(0,1fr)]">
            <Trust runs={history.data} summary={trust.data} metrics={metrics.data} />
            <Actions summary={summary.data} window={window} updatedAt={summary.updatedAt} />
          </div>
        </>
      )}

      <footer className="mono mt-6 flex flex-wrap justify-between gap-3 border-t border-line pt-4 text-[10.5px] tracking-[0.1em] text-ink-3 uppercase">
        <span>Agent evaluation</span>
        <span>Finished runs only · evidence is kept as recorded</span>
      </footer>
    </main>
  );
}

function count(summary: Summary, status: RunStatus) {
  return summary.by_status[status] ?? 0;
}

// ---------- Tiles: one strip, joined ----------

function Tiles({ summary, window, agent }: { summary: Summary; window: Window; agent: string }) {
  const evaluating = count(summary, "evaluating");
  const passed = count(summary, "passed");
  const decided = summary.runs - evaluating - count(summary, "could_not_run");
  const confirmed = count(summary, "confirmed");
  const agents = Object.keys(summary.by_agent).length;
  const tiles: { label: string; n: number; sub: string; status: RunStatus | "all"; tone: string }[] = [
    {
      label: "Runs observed",
      n: summary.runs,
      sub: evaluating ? `${evaluating} still being scored` : `Across ${agents} agent${agents === 1 ? "" : "s"}`,
      status: "all",
      tone: "text-ink",
    },
    {
      label: "Passed",
      n: passed,
      sub: decided ? `${((passed / decided) * 100).toFixed(1)}% of completed` : "Nothing completed yet",
      status: "passed",
      tone: "text-s-pass-fg",
    },
    {
      label: "Needs review",
      n: summary.pending_reviews,
      sub: summary.pending_reviews ? "Waiting on a person" : "Nothing waiting on you",
      status: "needs_review",
      tone: "text-s-need-fg",
    },
    { label: "Confirmed", n: confirmed, sub: confirmed ? "Action required" : "Nothing waiting for an action", status: "confirmed", tone: "text-s-conf-fg" },
    {
      label: "Resolved",
      n: count(summary, "resolved"),
      sub: summary.actions.length ? `${new Set(summary.actions.map((a) => a.resolved_by)).size} reviewers active` : "No actions yet",
      status: "resolved",
      tone: "text-s-res-fg",
    },
  ];
  return (
    <div className="grid overflow-hidden rounded-[4px] border border-line bg-surface [grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr))]">
      {tiles.map((tile) => (
        <Link
          key={tile.label}
          href={runsHref(tile.status, window, agent)}
          className="group -mb-px -ml-px flex flex-col gap-4 border-b border-l border-line px-5 pt-5 pb-4 text-ink no-underline hover:bg-surface-2"
        >
          <span className={`text-[34px] leading-none font-normal tracking-[-0.02em] tabular-nums ${tile.tone}`}>{tile.n}</span>
          <span className="flex items-end justify-between gap-2">
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] font-semibold">{tile.label}</span>
              <span className="text-[12px] text-ink-3">{tile.sub}</span>
            </span>
            <span className="text-ink-3 transition-transform group-hover:translate-x-0.5">
              <Icon.ChevronRight size={14} />
            </span>
          </span>
        </Link>
      ))}
    </div>
  );
}

// ---------- Status and causes ----------

function StatusPanel({ summary, window, agent }: { summary: Summary; window: Window; agent: string }) {
  const present = STATUS_ORDER.filter((s) => count(summary, s) > 0);
  const aria = "Runs by status: " + STATUS_ORDER.map((s) => `${STATUS[s].label} ${count(summary, s)}`).join(", ");
  return (
    <Card className="flex flex-col gap-5 p-5">
      <CardTitle eyebrow="Run outcomes" title="Status distribution" meta={`${summary.runs} total`} />
      <div className="flex h-6 gap-px overflow-hidden rounded-[2px] bg-surface-2" role="img" aria-label={aria}>
        {present.map((s) => (
          <div key={s} title={`${STATUS[s].label}: ${count(summary, s)}`} className="min-w-1.5" style={{ flex: `${count(summary, s)} 1 0`, background: STATUS_FILL[STATUS[s].key] }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {STATUS_ORDER.filter((s) => s !== "evaluating" || count(summary, s) > 0).map((s) => (
          <Link key={s} href={runsHref(s, window, agent)} className="inline-flex items-center gap-2 text-[12.5px] text-ink-2 no-underline hover:text-ink">
            <span className="size-2.5 flex-none rounded-[2px]" style={{ background: STATUS_FILL[STATUS[s].key] }} />
            {STATUS[s].label}
            <span className="font-semibold text-ink tabular-nums">{count(summary, s)}</span>
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
  return (
    <Card className="flex flex-col gap-4 p-5">
      <CardTitle eyebrow={`Failures ${windowNoun(window)}`} title="Failures by possible cause" />
      {entries.length === 0 ? (
        <p className="m-0 text-[13px] text-ink-3">No failures {windowNoun(window)}.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {entries.map(([pattern, n]) => (
            <li key={pattern} className="flex flex-col gap-1.5">
              <span className="flex justify-between gap-3 text-[12.5px]">
                <span>{patternLabel(pattern)}</span>
                <span className="font-semibold tabular-nums">{n}</span>
              </span>
              <span className="flex h-[5px] rounded-full bg-surface-2">
                <span className="h-full rounded-full" style={{ width: `${(n / max) * 100}%`, background: pattern === "no_explanation" ? "var(--ink3)" : "var(--accent)" }} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------- Checks ----------

const CHECK_COLUMNS = "[grid-template-columns:minmax(0,1fr)_90px_90px_90px_100px]";

function Checks({ summary, metrics }: { summary: Summary; metrics?: MetricInfo[] }) {
  const rows = Object.entries(summary.metrics).sort(([a], [b]) => metricOrder(a) - metricOrder(b));
  return (
    <Card className="flex flex-col gap-1 px-5 pt-5 pb-1">
      <CardTitle eyebrow="Evaluation coverage" title="Checks" />
      <div className="overflow-x-auto">
        <div className="min-w-[620px]">
          <div className={`mono grid gap-3 border-b border-line py-2.5 text-[10px] tracking-[0.1em] text-ink-3 uppercase ${CHECK_COLUMNS}`}>
            <span>Check</span>
            <span className="text-right">Checked</span>
            <span className="text-right">Flagged</span>
            <span className="text-right">Skipped</span>
            <span className="text-right">Avg. score</span>
          </div>
          {rows.length === 0 ? <p className="m-0 py-4 text-[13px] text-ink-3">No runs yet.</p> : null}
          {rows.map(([id, metric]) => (
            <div key={id} className={`grid items-center gap-3 border-b border-line-2 py-3 last:border-b-0 ${CHECK_COLUMNS}`}>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13.5px] font-semibold">{metricName(id, metrics)}</span>
                <span className="truncate text-[12px] text-ink-3">{CHECK_NOTE[id] ?? metrics?.find((m) => m.id === id)?.description}</span>
              </span>
              <span className="mono text-right text-[13px] tabular-nums">{metric.scored}</span>
              <span className={`mono text-right text-[13px] tabular-nums ${metric.failed ? "text-s-conf-fg" : "text-ink-3"}`}>{metric.failed}</span>
              <span className="mono text-right text-[13px] text-ink-3 tabular-nums">{metric.could_not_run + metric.missing_data}</span>
              <span className="mono text-right text-[13px] tabular-nums">{metric.average_score === null ? "—" : `${(metric.average_score * 100).toFixed(1)}%`}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ---------- Clean runs: how often runs come through with no real failure, day by day ----------

const CLEAN: RunStatus[] = ["passed", "false_alarm"];
const SETTLED: RunStatus[] = ["passed", "false_alarm", "needs_review", "confirmed", "resolved"];

function cleanShare(rows: RunRow[]): number | null {
  const settled = rows.filter((r) => SETTLED.includes(r.status));
  return settled.length ? settled.filter((r) => CLEAN.includes(r.status)).length / settled.length : null;
}

function Trust({ runs, summary, metrics }: { runs?: RunRow[]; summary?: Summary; metrics?: MetricInfo[] }) {
  const day = 24 * 3600_000;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  const recent = (runs ?? []).filter((r) => new Date(r.received_at).getTime() >= startMs - (TRUST_DAYS - 1) * day);
  const prior = (runs ?? []).filter((r) => {
    const t = new Date(r.received_at).getTime();
    return t < startMs - (TRUST_DAYS - 1) * day && t >= startMs - (TRUST_DAYS * 2 - 1) * day;
  });
  const days = Array.from({ length: TRUST_DAYS }, (_, i) => {
    const from = startMs - (TRUST_DAYS - 1 - i) * day;
    const rows = recent.filter((r) => {
      const t = new Date(r.received_at).getTime();
      return t >= from && t < from + day;
    });
    return { from, share: cleanShare(rows), n: rows.length };
  });
  const share = cleanShare(recent);
  const before = cleanShare(prior);
  const delta = share !== null && before !== null ? (share - before) * 100 : null;
  const label = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  // How often reviewers said a flagged failure was real, by check.
  const agreement = Object.entries(summary?.agreement_by_metric ?? {})
    .map(([id, c]) => ({ name: metricName(id, metrics), decided: c.correct + c.incorrect, share: c.agreement }))
    .filter((a) => a.decided > 0);

  return (
    <Card className="flex flex-col gap-4 p-5">
      <CardTitle eyebrow={`Last ${TRUST_DAYS} days`} title="Clean runs" meta="Runs with no real failure, by day" />
      {!runs ? (
        <p className="m-0 text-[13px] text-ink-3">Loading…</p>
      ) : share === null ? (
        <p className="m-0 text-[13px] text-ink-3">No finished runs in the last {TRUST_DAYS} days.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="mono text-[34px] leading-none tracking-[-0.02em] tabular-nums">{(share * 100).toFixed(1)}%</span>
            {delta !== null ? (
              <span className="text-[12px] text-ink-3">
                <span className={`font-semibold ${delta >= 0 ? "text-s-pass-fg" : "text-s-conf-fg"}`}>
                  {delta >= 0 ? "+" : ""}
                  {delta.toFixed(1)} pts
                </span>{" "}
                from the {TRUST_DAYS} days before
              </span>
            ) : (
              <span className="text-[12px] text-ink-3">of {recent.filter((r) => SETTLED.includes(r.status)).length} finished runs</span>
            )}
          </div>
          <div className="flex h-[150px] items-end gap-[3px]" role="img" aria-label={`Daily share of runs without a real failure, last ${TRUST_DAYS} days`}>
            {days.map((d) => (
              <span
                key={d.from}
                title={d.share === null ? `${label(d.from)}: no runs` : `${label(d.from)}: ${Math.round(d.share * 100)}% of ${d.n} runs`}
                className="flex-1 rounded-t-[1px]"
                style={{ height: d.share === null ? "3px" : `${Math.max(d.share * 100, 4)}%`, background: d.share === null ? "var(--line2)" : "var(--s-res)", opacity: d.share === null ? 1 : 0.75 }}
              />
            ))}
          </div>
          <div className="mono -mt-2 flex justify-between text-[10px] text-ink-3">
            <span>{label(days[0].from)}</span>
            <span>{label(days[Math.floor(TRUST_DAYS / 2)].from)}</span>
            <span>Today</span>
          </div>
        </>
      )}
      {agreement.length > 0 ? (
        <p className="m-0 mt-auto border-t border-line-2 pt-3 text-[12px] leading-normal text-ink-3">
          Reviewers agreed a flagged failure was real:{" "}
          {agreement.map((a, i) => (
            <span key={a.name}>
              {i ? " · " : ""}
              <span className="text-ink-2">{a.name}</span> {Math.round((a.share ?? 0) * 100)}% of {a.decided}
            </span>
          ))}
        </p>
      ) : null}
    </Card>
  );
}

// ---------- Actions ----------

function Actions({ summary, window, updatedAt }: { summary: Summary; window: Window; updatedAt?: Date }) {
  const today = updatedAt ?? new Date(summary.since);
  return (
    <Card className="flex flex-col gap-1 p-5">
      <CardTitle eyebrow="Completed resolutions" title="Actions taken" meta={windowNoun(window)} />
      {summary.actions.length === 0 ? (
        <p className="m-0 pt-3 text-[13px] text-ink-3">No actions recorded {windowNoun(window)}.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {summary.actions.slice(0, ACTIONS_SHOWN).map((action) => (
            <li key={action.run_id} className="border-b border-line-2 last:border-b-0">
              <Link
                href={`/runs/${action.run_id}`}
                className="grid w-full gap-x-3 py-3.5 text-left text-ink no-underline hover:bg-surface-2 [grid-template-columns:82px_minmax(0,1fr)]"
              >
                <span className="mono pt-0.5 text-[11px] text-ink-3">{formatTime(action.resolved_at, today)}</span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13px] leading-snug font-semibold">{action.action}</span>
                  <span className="text-[12px] text-ink-3">{action.agent_name}</span>
                  <span className="text-[11.5px] text-ink-3">Recorded by {action.resolved_by}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {summary.actions.length > ACTIONS_SHOWN ? (
        <Link href={runsHref("resolved", window)} className="mt-auto pt-2 text-[12.5px] font-medium text-accent no-underline hover:underline">
          See all {summary.actions.length} resolved runs
        </Link>
      ) : null}
    </Card>
  );
}
