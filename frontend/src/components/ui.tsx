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
export function ResultChip({ state }: { state: "failed" | "passed" | "could_not_run" | "missing_data" }) {
  const { label, key } = {
    failed: { label: "Failed", key: "conf" as const },
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

// ---------- How we know: solid for recorded and code, dashed for the AI judge, everywhere ----------

const BADGE = "inline-flex h-[22px] items-center gap-[5px] rounded px-2 text-[11.5px] font-semibold whitespace-nowrap";

export function RecordedBadge() {
  return (
    <span className={`${BADGE} border border-line bg-surface-2 text-ink`}>
      <Icon.List />
      Recorded
    </span>
  );
}

export function CodeBadge({ label = "Checked by code" }: { label?: string }) {
  return (
    <span className={`${BADGE} bg-ink text-canvas`}>
      <Icon.Check />
      {label}
    </span>
  );
}

export function JudgeBadge({ model }: { model?: string | null }) {
  return (
    <span className={`${BADGE} border border-dashed border-ink-3 text-ink-2`}>
      <Icon.Speech />
      AI judge
      {model ? (
        <>
          {" · "}
          <span className="mono font-medium">{model}</span>
        </>
      ) : null}
    </span>
  );
}

export function BasisBadge({ basis, model }: { basis: "recorded" | "computed" | "judged"; model?: string | null }) {
  if (basis === "recorded") return <RecordedBadge />;
  if (basis === "computed") return <CodeBadge />;
  return <JudgeBadge model={model} />;
}

export function MethodBadge({ method, model, codeLabel }: { method: "code" | "llm_judge"; model?: string | null; codeLabel?: string }) {
  return method === "code" ? <CodeBadge label={codeLabel} /> : <JudgeBadge model={model} />;
}

// ---------- Layout ----------

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-[10px] border border-line bg-surface ${className}`}>{children}</section>;
}

export function CardTitle({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <div>
      <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
      {sub ? <p className="mt-1 mb-0 text-[13px] text-ink-3">{sub}</p> : null}
    </div>
  );
}

export function PageTitle({ title, sub, children }: { title: string; sub: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="m-0 text-[26px] font-bold tracking-[-0.02em]">{title}</h1>
        <p className="mt-1.5 mb-0 text-sm text-ink-2">{sub}</p>
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2.5">{children}</div> : null}
    </div>
  );
}

export function Select({ label, id, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; id: string }) {
  return (
    <>
      <label htmlFor={id} className="text-[13px] text-ink-3">
        {label}
      </label>
      <select
        id={id}
        {...props}
        className="h-10 rounded-lg border border-line bg-surface px-3 text-sm font-medium text-ink"
      />
    </>
  );
}

export function LiveNote({ updatedAt }: { updatedAt?: Date }) {
  return (
    <span className="flex items-center gap-2 text-[12.5px] text-ink-3">
      <span className="size-[7px] animate-pulse-dot rounded-full bg-accent" />
      {updatedAt ? `Live · updated ${updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}` : "Connecting…"}
    </span>
  );
}

export function ErrorNote({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-s-conf bg-s-conf-bg px-4 py-3 text-sm text-s-conf-fg">
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

// ---------- Icons (from the prototype) ----------

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
