"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/lib/api";
import { onChange, useDarkTheme } from "@/lib/browser-state";
import { PRODUCT_NAME } from "@/lib/constants";
import { DEFAULT_WINDOW, sinceOf } from "@/lib/time";
import { useResource } from "@/lib/use-resource";
import { Icon } from "./ui";

export function Header() {
  const pathname = usePathname();
  const [dark, toggleDark] = useDarkTheme();
  // The needs-review count for the badge, over the default window: refetched on every navigation and after a review.
  const { data, refresh } = useResource(`nav:${pathname}`, () => api.summary({ since: sinceOf(DEFAULT_WINDOW) }));
  useEffect(() => onChange(refresh), [refresh]);
  const needs = data?.pending_reviews ?? 0;
  const onToday = pathname === "/";

  const navClass = (on: boolean) =>
    `relative inline-flex h-[58px] items-center gap-2 px-1 text-[13.5px] no-underline ${
      on ? "font-semibold text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-ink" : "font-medium text-ink-2 hover:text-ink"
    }`;

  return (
    <header className="grid min-h-[58px] items-center gap-x-6 border-b border-line bg-surface px-8 [grid-template-columns:1fr_auto_1fr]">
      <Link href="/" className="text-[15px] font-semibold tracking-[-0.01em] text-ink no-underline">
        {PRODUCT_NAME}
      </Link>
      <nav aria-label="Main" className="flex gap-7">
        <Link href="/" className={navClass(onToday)} aria-current={onToday ? "page" : undefined}>
          Overview
        </Link>
        <Link href="/runs" className={navClass(!onToday)} aria-current={!onToday ? "page" : undefined}>
          Runs
          {needs > 0 ? (
            <span
              className="inline-flex size-[18px] items-center justify-center rounded-full bg-s-conf text-[10.5px] font-semibold text-white"
              aria-label={`${needs} need review`}
            >
              {needs}
            </span>
          ) : null}
        </Link>
      </nav>
      <div className="flex items-center justify-end gap-4">
        <span className="mono hidden items-center gap-2 text-[10.5px] tracking-[0.1em] text-ink-3 uppercase sm:flex">
          <span className="size-[6px] rounded-full bg-s-pass" />
          Live data
        </span>
        <button
          onClick={toggleDark}
          aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
          className="grid size-9 place-items-center rounded-full border border-line text-ink-2 hover:bg-surface-2"
        >
          {dark ? <Icon.Sun /> : <Icon.Moon />}
        </button>
      </div>
    </header>
  );
}
