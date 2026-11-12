"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/lib/api";
import { onChange, useDarkTheme } from "@/lib/browser-state";
import { PRODUCT_NAME } from "@/lib/constants";
import { sinceOf } from "@/lib/time";
import { useResource } from "@/lib/use-resource";
import { Icon } from "./ui";

export function Header() {
  const pathname = usePathname();
  const [dark, toggleDark] = useDarkTheme();
  // Today's needs-review count for the badge: refetched on every navigation and after a review.
  const { data, refresh } = useResource(`nav:${pathname}`, () => api.summary({ since: sinceOf("today") }));
  useEffect(() => onChange(refresh), [refresh]);
  const needs = data?.pending_reviews ?? 0;
  const onToday = pathname === "/";

  const navClass = (on: boolean) =>
    `inline-flex h-10 items-center gap-2 rounded-lg px-3.5 text-sm hover:bg-surface-2 ${
      on ? "bg-surface-2 font-semibold text-ink" : "font-medium text-ink-2"
    }`;

  return (
    <header className="flex min-h-[60px] flex-wrap items-center gap-x-7 gap-y-3 border-b border-line bg-surface px-8 py-2">
      <Link href="/" className="flex items-center gap-2.5 text-[15px] font-bold tracking-[-0.01em] text-ink no-underline">
        <Icon.Logo />
        <span>{PRODUCT_NAME}</span>
      </Link>
      <nav aria-label="Main" className="flex gap-1">
        <Link href="/" className={navClass(onToday)} aria-current={onToday ? "page" : undefined}>
          Today
        </Link>
        <Link href="/runs" className={navClass(!onToday)} aria-current={!onToday ? "page" : undefined}>
          Runs
          {needs > 0 ? (
            <span
              className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-full bg-s-need-bg px-1.5 text-xs font-bold text-s-need-fg"
              aria-label={`${needs} need review`}
            >
              {needs}
            </span>
          ) : null}
        </Link>
      </nav>
      <div className="ml-auto flex items-center gap-4">
        <button
          onClick={toggleDark}
          aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
          className="grid size-11 place-items-center rounded-lg border border-line text-ink-2 hover:bg-surface-2"
        >
          {dark ? <Icon.Sun /> : <Icon.Moon />}
        </button>
      </div>
    </header>
  );
}
