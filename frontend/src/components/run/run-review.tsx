"use client";

import Link from "next/link";
import { useState } from "react";
import { api, type MetricInfo, type Review, type ReviewIn, type ReviewVerdict, type RunReport } from "@/lib/api";
import { useStoredText } from "@/lib/browser-state";
import { metricName, REVIEW_QUESTION, reviewLabel } from "@/lib/labels";
import { isLimit, readableMs } from "@/lib/metrics";
import { firstSentence } from "@/lib/run-text";
import { formatTime } from "@/lib/time";
import { Card, Icon, StatusChip } from "../ui";

const REVIEWER_KEY = "agent-eval:reviewer";
const VERDICTS: ReviewVerdict[] = ["correct", "incorrect", "inconclusive"];

type Item = { key: string; kind: string; title: string; detail?: string; question: string; target: Pick<ReviewIn, "target" | "metric_id" | "explanation"> };

function keyOf(review: Pick<ReviewIn, "target" | "metric_id" | "explanation">) {
  return review.target === "metric_result" ? `m:${review.metric_id}` : `e:${review.explanation}`;
}

const HEADLINE: Record<RunReport["status"], string> = {
  evaluating: "Opens once the run is scored.",
  passed: "Nothing failed, so there’s nothing to review.",
  could_not_run: "Nothing failed, but a check couldn’t run. Nothing to review.",
  needs_review: "“Real failure” confirms the run. “Not sure” keeps it here for someone else.",
  confirmed: "A failure is real. Record what was done about it.",
  false_alarm: "Reviewers ruled every failure a false alarm, so our tool was wrong here.",
  resolved: "Action recorded.",
};

/**
 * The review, pinned beside the lineage: every failed check and explanation gets a verdict, the action
 * is recorded once a failure is confirmed, and every review is kept in the history.
 * Each verdict is posted to the API; the run and its status are then fetched again.
 */
export function ReviewRail({
  report,
  failed,
  metrics,
  now,
  onChanged,
}: {
  report: RunReport;
  failed: boolean;
  metrics?: MetricInfo[];
  now: Date;
  onChanged: () => void;
}) {
  const [reviewer, setReviewer] = useStoredText(REVIEWER_KEY, "");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const { status } = report;

  // Measured failures (speed, cost, recorded step errors) are confirmed without a review.
  const measured = report.results.filter((r) => r.passed === false && r.review === "auto");
  const items: Item[] = [
    ...report.results
      .filter((r) => r.passed === false && r.review !== "auto")
      .map((r) => ({
        key: `m:${r.metric_id}`,
        kind: isLimit(r) ? "Over the limit" : "Failed check",
        title: metricName(r.metric_id, metrics),
        detail: `${r.score?.toFixed(2) ?? ""} · ${readableMs(firstSentence(r.reason))}`,
        question: REVIEW_QUESTION.metric_result,
        target: { target: "metric_result" as const, metric_id: r.metric_id },
      })),
    ...(report.diagnosis?.explanations ?? []).map((e, i) => ({
      key: `e:${i}`,
      kind: `Possibility ${i + 1}`,
      title: e.summary,
      question: REVIEW_QUESTION.explanation,
      target: { target: "explanation" as const, explanation: i },
    })),
  ];

  // Reviews come oldest first; the latest one about the same thing counts.
  const latest = new Map<string, Review>();
  for (const review of report.reviews) latest.set(keyOf(review), review);

  const send = async (item: Item, verdict: ReviewVerdict) => {
    const name = reviewer.trim();
    if (!name) {
      setError("Enter your name in “Reviewing as” first.");
      document.getElementById("reviewer")?.focus();
      return;
    }
    setBusy(item.key);
    setError(null);
    try {
      await api.addReview(report.run.id, { ...item.target, verdict, reviewer: name, note: notes[item.key]?.trim() || undefined });
      setNotes((n) => ({ ...n, [item.key]: "" }));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const describe = (review: Review) =>
    review.target === "metric_result" ? metricName(review.metric_id ?? "", metrics) : `possibility ${(review.explanation ?? 0) + 1}`;

  return (
    <Card className="flex flex-col">
      <div className="flex flex-col gap-1.5 border-b border-line-2 px-4 py-3.5">
        <StatusChip status={status} size="lg" />
        <p className="m-0 text-[13px] leading-normal text-ink-2">{HEADLINE[status]}</p>
      </div>

      {!failed ? null : (
        <>
          <div className="flex items-center gap-2 border-b border-line-2 px-4 py-3">
            <label htmlFor="reviewer" className="text-[13px] whitespace-nowrap text-ink-3">
              Reviewing as
            </label>
            <input
              id="reviewer"
              value={reviewer}
              onChange={(e) => setReviewer(e.target.value)}
              placeholder="Your name"
              className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm"
            />
          </div>

          {error ? (
            <div role="alert" className="border-b border-line-2 bg-s-conf-bg px-4 py-2.5 text-[13px] font-medium text-s-conf-fg">
              {error}
            </div>
          ) : null}

          {measured.length > 0 ? (
            <div className="flex flex-col gap-1.5 border-b border-line-2 px-4 py-3">
              <div className="text-xs font-semibold text-ink-3">Confirmed without a review</div>
              {measured.map((r) => (
                <div key={r.metric_id} className="flex items-center gap-2 text-[13.5px]">
                  <span className="text-s-conf">
                    <Icon.Check size={14} />
                  </span>
                  <span className="font-semibold">{metricName(r.metric_id, metrics)}</span>
                  <span className="text-ink-3">{isLimit(r) ? "over the limit, measured" : "measured"}</span>
                </div>
              ))}
            </div>
          ) : null}

          {items.map((item) => {
            const current = latest.get(item.key)?.verdict;
            return (
              <div key={item.key} className="flex flex-col gap-2 border-b border-line-2 px-4 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-semibold text-ink-3">{item.kind}</span>
                  <span className={`text-[12px] ${current ? "font-semibold text-ink" : "text-ink-3"}`}>
                    {current ? `Latest: ${reviewLabel(item.target.target, current)}` : "Not reviewed yet"}
                  </span>
                </div>
                <div className="text-[14px] leading-[1.4] font-semibold">{item.title}</div>
                {item.detail ? <div className="text-[12.5px] leading-normal text-ink-3">{item.detail}</div> : null}
                <div className="text-[12.5px] text-ink-2">{item.question}</div>
                <div className="flex gap-1.5">
                  {VERDICTS.map((v) => {
                    const on = current === v;
                    return (
                      <button
                        key={v}
                        onClick={() => send(item, v)}
                        disabled={busy !== null}
                        aria-pressed={on}
                        className={`h-9 flex-1 rounded-lg border px-2 text-[13px] font-semibold disabled:opacity-60 ${
                          on ? "border-ink bg-ink text-canvas" : "border-line bg-surface text-ink hover:bg-surface-2"
                        }`}
                      >
                        {busy === item.key ? "…" : reviewLabel(item.target.target, v)}
                      </button>
                    );
                  })}
                </div>
                <input
                  value={notes[item.key] ?? ""}
                  onChange={(e) => setNotes((n) => ({ ...n, [item.key]: e.target.value }))}
                  aria-label={`Optional note on ${item.title}`}
                  placeholder="Optional note"
                  className="h-9 rounded-lg border border-line bg-surface px-3 text-[13px]"
                />
              </div>
            );
          })}

          <ActionTaken report={report} now={now} reviewer={reviewer.trim()} onChanged={onChanged} />

          <div className="px-4 py-3">
            <button
              onClick={() => setHistoryOpen((o) => !o)}
              aria-expanded={historyOpen}
              className="flex h-8 items-center gap-1.5 rounded-md text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase hover:text-ink"
            >
              <span className={`transition-transform ${historyOpen ? "rotate-90" : ""}`}>
                <Icon.ChevronRight size={14} />
              </span>
              Review history ({report.reviews.length})
            </button>
            {historyOpen ? (
              report.reviews.length === 0 ? (
                <p className="mt-1 mb-0 text-[13px] text-ink-3">No reviews yet.</p>
              ) : (
                <ol className="mt-1 mb-0 list-none p-0">
                  {[...report.reviews].reverse().map((review) => {
                    const counts = latest.get(keyOf(review))?.id === review.id;
                    return (
                      <li key={review.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line-2 py-2 text-[12.5px]">
                        <span className="mono text-ink-3">{formatTime(review.reviewed_at, now)}</span>
                        <span className="font-semibold">{review.reviewer}</span>
                        <span className="text-ink-2">on {describe(review)}:</span>
                        <span className="inline-flex h-5 items-center rounded-full border border-line px-1.5 text-[11px] font-semibold">{reviewLabel(review.target, review.verdict)}</span>
                        {!counts ? <span className="text-[11px] text-ink-3">replaced later</span> : null}
                        {review.note ? <span className="basis-full leading-[1.4] text-ink-2">“{review.note}”</span> : null}
                      </li>
                    );
                  })}
                </ol>
              )
            ) : null}
          </div>
        </>
      )}
    </Card>
  );
}

/** The action box: a form while the run is confirmed, the recorded action once it's resolved. */
function ActionTaken({ report, now, reviewer, onChanged }: { report: RunReport; now: Date; reviewer: string; onChanged: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { status, resolution } = report;

  if (status === "resolved" && resolution) {
    return (
      <div className="flex flex-col gap-2 border-b border-line-2 bg-s-res-bg px-4 py-3.5">
        <div className="flex items-center gap-2 text-xs font-semibold text-s-res-fg">
          <Icon.Check size={14} />
          Action taken · {formatTime(resolution.resolved_at, now)} by {resolution.resolved_by}
        </div>
        <p className="m-0 text-[14.5px] leading-normal font-medium text-ink">{resolution.action}</p>
        <Link href="/" className="inline-flex h-9 w-fit items-center rounded-lg border border-line bg-surface px-3 text-[13px] font-semibold text-ink no-underline hover:bg-surface-2">
          Back to the overview
        </Link>
      </div>
    );
  }

  if (status !== "confirmed") {
    return (
      <div className="border-b border-line-2 px-4 py-3">
        <div className="text-xs font-semibold text-ink-3">Action taken</div>
        <p className="mt-1 mb-0 text-[12.5px] leading-normal text-ink-3">
          {status === "false_alarm" ? "No action needed: every failure was ruled a false alarm." : "Opens once a failure is confirmed."}
        </p>
      </div>
    );
  }

  const empty = !text.trim();
  const submit = async () => {
    if (empty) return;
    if (!reviewer) {
      setError("Enter your name in “Reviewing as” first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.resolve(report.run.id, { action: text.trim(), resolved_by: reviewer });
      setText("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 border-b border-line-2 bg-s-conf-bg/40 px-4 py-3.5">
      <label htmlFor="action-text" className="text-xs font-semibold text-ink-3">
        Action taken
      </label>
      <div className="text-[13.5px] leading-normal font-medium">This failure is real. What was done about it?</div>
      <textarea
        id="action-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="For example: Raised the price tool timeout from 2 s to 5 s"
        className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px] leading-normal"
      />
      {error ? (
        <div role="alert" className="text-[13px] font-medium text-s-conf-fg">
          {error}
        </div>
      ) : null}
      <button onClick={submit} disabled={empty || busy} className="h-10 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink disabled:opacity-45">
        {busy ? "Saving…" : "Record action and resolve"}
      </button>
      <span className="text-[12px] text-ink-3">{reviewer ? `Recorded as ${reviewer}. ` : ""}The run becomes Resolved.</span>
    </div>
  );
}
