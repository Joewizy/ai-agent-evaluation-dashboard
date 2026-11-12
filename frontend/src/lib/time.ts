/** Time windows and formatting. Windows are worked out in the browser, so "today" is the viewer's midnight. */

export type Window = "today" | "24h" | "7d";

export const WINDOWS: { value: Window; label: string }[] = [
  { value: "today", label: "Since midnight today" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
];

export function isWindow(value: string | null): value is Window {
  return value === "today" || value === "24h" || value === "7d";
}

/** The start of a window as an ISO time. Call it when fetching, not while rendering. */
export function sinceOf(window: Window): string {
  const now = new Date();
  if (window === "24h") return new Date(now.getTime() - 24 * 3600_000).toISOString();
  if (window === "7d") return new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
}

export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 3600_000).toISOString();
}

export function windowNoun(window: Window): string {
  return { today: "since midnight", "24h": "in the last 24 hours", "7d": "in the last 7 days" }[window];
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const dayAndClock = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "14:52" for today, "10 Nov 14:52" for earlier days. */
export function formatTime(iso: string, today: Date): string {
  const date = new Date(iso);
  return date.toDateString() === today.toDateString() ? clock.format(date) : dayAndClock.format(date);
}

export function formatClock(date: Date): string {
  return clock.format(date);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
}
