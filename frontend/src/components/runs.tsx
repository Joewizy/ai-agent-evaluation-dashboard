"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api, type MetricInfo, type RunRow, type RunStatus } from "@/lib/api";
import { isStatus, patternLabel } from "@/lib/labels";
import { headline, isLimit, metricOrder } from "@/lib/metrics";
import { DEFAULT_WINDOW, formatTime, isWindow, sinceOf, type Window, windowNoun, WINDOWS } from "@/lib/time";
import { useResource } from "@/lib/use-resource";
import { Card, ErrorNote, Icon, Loading, PageTitle, Select, StatusChip } from "./ui";

type Tab = RunStatus | "all";

const TABS: { value: Tab; label: string }[] = [
  { value: "needs_review", label: "Needs review" },
  { value: "all", label: "All" },
  { value: "confirmed", label: "Confirmed" },
  { value: "false_alarm", label: "False alarm" },
  { value: "resolved", label: "Resolved" },
  { value: "could_not_run", label: "Couldn’t be checked" },
  { value: "evaluating", label: "Evaluating" },
  { value: "passed", label: "Passed" },
];

/** Time, agent, mode, status, one column per check, possible causes, chevron. */
function columnsFor(metrics: MetricInfo[]): { template: string; minWidth: number } {
  const perMetric = "minmax(92px,0.6fr)";
  return {
    template: ["96px", "130px", "76px", "150px", ...metrics.map(() => perMetric), "minmax(200px,1.2fr)", "24px"].join(" "),
    minWidth: 720 + 92 * metrics.length,
  };
}

export function RunsView() {
  const router = useRouter();
  const params = useSearchParams();
  const rawStatus = params.get("status");
  const tab: Tab = rawStatus === "all" || isStatus(rawStatus) ? rawStatus : "needs_review";
  const agent = params.get("agent") ?? "";
  const rawSince = params.get("since");
  const window: Window = isWindow(rawSince) ? rawSince : DEFAULT_WINDOW;

  // One request for the whole window: tab counts, the agent list and the rows all come from the API's statuses.
  // Poll only while something in the window is still being scored.
  const runs = useResource(
    `runs:${window}`,
    () => api.runs({ since: sinceOf(window) }),
    (rows) => !!rows?.some((r) => r.status === "evaluating"),
  );
  const metrics = useResource("metrics", api.metrics);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`/runs?${next}`);
  };

  const all = runs.data ?? [];
  const agents = [...new Set(all.map((r) => r.agent_name))].sort();
  if (agent && !agents.includes(agent)) agents.push(agent);
  const forAgent = agent ? all.filter((r) => r.agent_name === agent) : all;
  const counts = (t: Tab) => (t === "all" ? forAgent.length : forAgent.filter((r) => r.status === t).length);
  const rows = tab === "all" ? forAgent : forAgent.filter((r) => r.status === tab);
  const today = runs.updatedAt ?? null;
  const metricList = [...(metrics.data ?? [])].sort((a, b) => metricOrder(a.id) - metricOrder(b.id));
  const { template, minWidth } = columnsFor(metricList);

  return (
    <main className="mx-auto flex max-w-[1620px] flex-col gap-[18px] px-8 pt-7 pb-[72px]">
      <PageTitle title="Runs" sub="Failures wait in Needs review until a person checks them.">
        <Select id="since-runs" label="Showing" value={window} onChange={(e) => setParam("since", e.target.value === DEFAULT_WINDOW ? null : e.target.value)}>
          {WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </Select>
        <span className="ml-1.5" />
        <Select id="agent-filter" label="Agent" value={agent} onChange={(e) => setParam("agent", e.target.value || null)}>
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
      </PageTitle>

      <div className="flex flex-wrap gap-0.5 border-b border-line" role="tablist" aria-label="Status">
        {TABS.map((t) => {
          const on = t.value === tab;
          const n = counts(t.value);
          const urgent = t.value === "needs_review" && n > 0;
          return (
            <button
              key={t.value}
              role="tab"
              aria-selected={on}
              onClick={() => setParam("status", t.value)}
              className={`-mb-px inline-flex h-11 items-center gap-2 rounded-t-lg px-3.5 text-sm hover:bg-surface-2 ${
                on ? "font-semibold text-ink shadow-[inset_0_-2px_0_var(--accent)]" : "font-medium text-ink-2"
              }`}
            >
              {t.label}
              <span
                className={`inline-flex h-5 min-w-[22px] items-center justify-center rounded-full px-1.5 text-xs font-bold ${
                  urgent ? "bg-s-need-bg text-s-need-fg" : "bg-surface-2 text-ink-2"
                }`}
              >
                {runs.data ? n : "·"}
              </span>
            </button>
          );
        })}
      </div>

      {runs.error ? <ErrorNote error={runs.error} onRetry={runs.refresh} /> : null}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <div style={{ minWidth }}>
            <div className="grid gap-3.5 border-b border-line px-5 py-3 text-xs font-semibold text-ink-3" style={{ gridTemplateColumns: template }}>
              <span>Time</span>
              <span>Agent</span>
              <span>Mode</span>
              <span>Status</span>
              {metricList.map((m) => (
                <span key={m.id} className="truncate" title={m.description}>
                  {m.name}
                </span>
              ))}
              <span>Possible causes</span>
              <span />
            </div>
            {!runs.data && !runs.error ? <Loading /> : null}
            {rows.map((row) => (
              <Row key={row.id} row={row} today={today} metrics={metricList} template={template} />
            ))}
            {runs.data && rows.length === 0 ? (
              <p className="m-0 px-5 py-10 text-center text-sm text-ink-3">
                No {tab === "all" ? "" : TABS.find((t) => t.value === tab)?.label.toLowerCase() + " "}runs {windowNoun(window)}
                {agent ? ` for ${agent}` : ""}.
              </p>
            ) : null}
          </div>
        </div>
        {runs.data ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line-2 px-5 py-3 text-[13px] text-ink-3">
            <span>
              Showing {rows.length} of {all.length} runs {windowNoun(window)}
            </span>
            <span>Failed checks are in red. A dash means the check didn’t run.</span>
          </div>
        ) : null}
      </Card>
    </main>
  );
}

function Row({ row, today, metrics, template }: { row: RunRow; today: Date | null; metrics: MetricInfo[]; template: string }) {
  return (
    <Link
      href={`/runs/${row.id}`}
      className="grid min-h-[52px] w-full items-center gap-3.5 border-b border-line-2 px-5 py-3 text-left text-ink no-underline hover:bg-surface-2"
      style={{ gridTemplateColumns: template }}
    >
      <span className="mono text-[13px] text-ink-2">{today ? formatTime(row.received_at, today) : ""}</span>
      <span className={`mono truncate text-[13px] font-medium ${row.agent_name ? "" : "text-ink-3"}`}>{row.agent_name || "unnamed agent"}</span>
      <span className="text-[13px] text-ink-2">{row.mode === "live" ? "Live" : "Testing"}</span>
      <span>
        <StatusChip status={row.status} />
      </span>
      {metrics.map((m) => {
        const result = row.results?.[m.id];
        const scored = !!result && result.score !== null;
        return (
          <span
            key={m.id}
            className={`mono text-[13px] ${
              !scored ? "text-ink-3" : result.passed === false ? `font-semibold ${isLimit({ metric_id: m.id }) ? "text-s-need-fg" : "text-s-conf-fg"}` : "text-ink-2"
            }`}
          >
            {scored ? headline(m.id, result, row) : row.status === "evaluating" ? "…" : "—"}
          </span>
        );
      })}
      <span className="flex flex-wrap gap-1.5">
        {row.causes.map((cause) => (
          <span key={cause} className="inline-flex h-[22px] items-center whitespace-nowrap rounded bg-surface-2 px-2 text-xs font-medium text-ink-2">
            {patternLabel(cause)}
          </span>
        ))}
      </span>
      <span className="flex justify-end text-ink-3">
        <Icon.ChevronRight />
      </span>
    </Link>
  );
}
