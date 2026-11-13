/** Shared building blocks. Every status chip and evidence badge in the app comes from here. */

import type { ReactNode, SelectHTMLAttributes } from "react";
import type { RunStatus } from "@/lib/api";
import { STATUS, type StatusKey } from "@/lib/labels";

// ---------- Status ----------

const CHIP: Record<StatusKey, string> = {
  eval: "bg-s-eval-bg text-s-eval-fg",
  pass: "bg-s-pass-bg text-s-pass-fg",
  cnc: "bg-s-cnc-bg text-s-cnc-fg",
  need: "bg-s-need-bg text-s-need-fg",
  conf: "bg-s-conf-bg text-s-conf-fg",
  fa: "bg-s-fa-bg text-s-fa-fg",
  res: "bg-s-res-bg text-s-res-fg",
};

export const STATUS_FILL: Record<StatusKey, string> = {
  eval: "repeating-linear-gradient(135deg, var(--s-eval) 0 3px, var(--s-eval-bg) 3px 6px)",
  pass: "var(--s-pass)",
  cnc: "var(--s-cnc)",
  need: "var(--s-need)",
  conf: "var(--s-conf)",
  fa: "var(--s-fa)",
  res: "var(--s-res)",
};

export function StatusChip({ status, size = "sm" }: { status: RunStatus; size?: "sm" | "lg" }) {
  const { label, key } = STATUS[status];
  const sizing = size === "lg" ? "h-[30px] pl-2.5 pr-3 text-[13.5px]" : "h-6 pl-2 pr-2.5 text-xs";
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-semibold ${sizing} ${CHIP[key]}`}>
      <span
        className={`size-[7px] flex-none rounded-full ${status === "evaluating" ? "animate-pulse-dot" : ""}`}
        style={{ background: `var(--s-${key})` }}
      />
      {label}
    </span>
  );
}

/** A small pill for a metric result's state on the run page. */
export function ResultChip({ state }: { state: "failed" | "over_limit" | "passed" | "could_not_run" | "missing_data" }) {
  const { label, key } = {
    failed: { label: "Failed", key: "conf" as const },
    over_limit: { label: "Over the limit", key: "need" as const },
    passed: { label: "Passed", key: "pass" as const },
    could_not_run: { label: "Couldn’t run", key: "cnc" as const },
    missing_data: { label: "Missing data", key: "cnc" as const },
  }[state];
  return (
    <span className={`inline-flex h-[22px] items-center whitespace-nowrap rounded-full px-2 text-[11.5px] font-semibold ${CHIP[key]}`}>
      {label}
    </span>
  );
}

// ---------- Evidence basis ----------

/** Evidence-basis tag: green dot for recorded data, ink for code checks, amber for the AI judge. */
function Tag({ dot, children }: { dot: string; children: ReactNode }) {
  return (
    <span className="mono inline-flex h-[20px] items-center gap-1.5 rounded-[3px] border border-line px-1.5 text-[10.5px] font-medium tracking-[0.06em] whitespace-nowrap text-ink-2 uppercase">
      <span className="size-[6px] flex-none rounded-full" style={{ background: dot }} />
      {children}
    </span>
  );
}

export function RecordedBadge() {
  return <Tag dot="var(--s-pass)">Recorded</Tag>;
}

export function CodeBadge({ label = "Code" }: { label?: string }) {
  return <Tag dot="var(--ink)">{label === "Checked by code" ? "Code" : label}</Tag>;
}

/** The judge model is stored with each result but not displayed. */
export function JudgeBadge() {
  return <Tag dot="var(--s-need)">AI judge</Tag>;
}

export function BasisBadge({ basis }: { basis: "recorded" | "computed" | "judged" }) {
  if (basis === "recorded") return <RecordedBadge />;
  if (basis === "computed") return <CodeBadge />;
  return <JudgeBadge />;
}

export function MethodBadge({ method, codeLabel }: { method: "code" | "llm_judge"; codeLabel?: string }) {
  return method === "code" ? <CodeBadge label={codeLabel} /> : <JudgeBadge />;
}

// ---------- Layout ----------

export function Card({ children, className = "", id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`rounded-[4px] border border-line bg-surface ${className}`}>
      {children}
    </section>
  );
}

/** A panel heading: a small red label, a serif title, an optional note on the right, then a rule. */
export function CardTitle({ title, sub, eyebrow, meta }: { title: string; sub?: ReactNode; eyebrow?: string; meta?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-line pb-3">
      {eyebrow ? <span className="mono text-[10.5px] font-medium tracking-[0.1em] text-eyebrow uppercase">{eyebrow}</span> : null}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="m-0 font-serif text-[22px] leading-tight font-normal tracking-[-0.01em]">{title}</h2>
        {meta ? <span className="mono text-[11px] text-ink-3">{meta}</span> : null}
      </div>
      {sub ? <p className="m-0 text-[12.5px] leading-normal text-ink-3">{sub}</p> : null}
    </div>
  );
}

export function PageTitle({ title, sub, eyebrow, children }: { title: string; sub: string; eyebrow?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <span className="mono min-h-[16px] text-[11px] font-medium tracking-[0.1em] text-eyebrow uppercase">{eyebrow ?? ""}</span>
        <h1 className="m-0 font-serif text-[40px] leading-none font-normal tracking-[-0.02em]">{title}</h1>
        <p className="mt-1.5 mb-0 text-sm text-ink-2">{sub}</p>
      </div>
      {children ? <div className="flex flex-wrap items-end gap-2.5">{children}</div> : null}
    </div>
  );
}

export function Select({ label, id, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; id: string }) {
  return (
    <span className="flex flex-col gap-1">
      <label htmlFor={id} className="mono text-[10px] font-medium tracking-[0.1em] text-ink-3 uppercase">
        {label}
      </label>
      <select id={id} {...props} className="h-9 rounded-[3px] border border-line bg-surface px-2.5 text-[13px] font-medium text-ink" />
    </span>
  );
}

export function LiveNote({ updatedAt }: { updatedAt?: Date }) {
  return (
    <span className="mono flex h-9 items-center gap-2 text-[11px] text-ink-3">
      <span className="size-[6px] animate-pulse-dot rounded-full bg-s-pass" />
      {updatedAt ? `Updated ${updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}` : "Connecting…"}
    </span>
  );
}

export function ErrorNote({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[4px] border border-s-conf bg-s-conf-bg px-4 py-3 text-sm text-s-conf-fg">
      <span>
        <strong className="font-semibold">{error.message}</strong>
        {error.message.startsWith("Can't reach") ? (
          <> Start it with <span className="mono">uvicorn app.main:app</span> in backend/, then try again.</>
        ) : null}
      </span>
      {onRetry ? (
        <button onClick={onRetry} className="h-9 rounded-lg border border-s-conf bg-surface px-3 text-[13px] font-semibold text-ink">
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <p className="m-0 py-10 text-center text-sm text-ink-3">{label}</p>;
}

// ---------- Icons ----------

export const Icon = {
  Logo: () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21" />
      <path d="M7.5 10.5h6M10.5 7.5v6" />
    </svg>
  ),
  Moon: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </svg>
  ),
  Sun: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </svg>
  ),
  Check: ({ size = 12, width = 2.6 }: { size?: number; width?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  ),
  Cross: () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  List: () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </svg>
  ),
  Speech: () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5h16v11H10l-6 4z" />
    </svg>
  ),
  ChevronRight: ({ size = 16, stroke = "currentColor" }: { size?: number; stroke?: string }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  ChevronLeft: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  ),
  Warning: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l9.5 17h-19z" />
      <path d="M12 10v4M12 17.5v.01" />
    </svg>
  ),
  Info: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.5v.01" />
    </svg>
  ),
  Question: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ink2)" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.6M12 16.8v.01" />
    </svg>
  ),
};
