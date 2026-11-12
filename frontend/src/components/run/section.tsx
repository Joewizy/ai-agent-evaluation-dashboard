import type { ReactNode } from "react";

/** One numbered step of the run lineage, with the line that joins it to the next. */

export type SpineState = "neutral" | "pending" | "done" | "resolved";

export const SPINE: Record<SpineState, string> = {
  neutral: "bg-surface border-line text-ink-2",
  pending: "bg-s-need-bg border-s-need text-s-need-fg",
  done: "bg-ink border-ink text-canvas",
  resolved: "bg-s-res border-s-res text-white",
};

export function Section({
  n,
  id,
  title,
  state = "neutral",
  last = false,
  children,
}: {
  n: number;
  id: string;
  title: string;
  state?: SpineState;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id} className="grid scroll-mt-4 gap-x-4 [grid-template-columns:32px_minmax(0,1fr)]">
      <div className="flex flex-col items-center">
        <span className={`grid size-7 flex-none place-items-center rounded-full border-[1.5px] text-xs font-semibold ${SPINE[state]}`}>{n}</span>
        {last ? null : <span className="mt-1.5 w-0.5 flex-1 bg-line" />}
      </div>
      <div className={`min-w-0 ${last ? "pb-4" : "pb-8"}`}>
        <h2 className="eyebrow">{title}</h2>
        {children}
      </div>
    </section>
  );
}
