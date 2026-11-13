/** Time windows and formatting. Windows are rolling: the last 24 hours, 7 days or 30 days up to now. */

export type Window = "24h" | "7d" | "30d";

/** The window used when the URL names none. */
export const DEFAULT_WINDOW: Window = "24h";

export const WINDOWS: { value: Window; label: string }[] = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

export function isWindow(value: string | null): value is Window {
  return value === "24h" || value === "7d" || value === "30d";
}

const WINDOW_HOURS: Record<Window, number> = { "24h": 24, "7d": 7 * 24, "30d": 30 * 24 };

/** The start of a window as an ISO time. Call it when fetching, not while rendering. */
export function sinceOf(window: Window): string {
  return new Date(Date.now() - WINDOW_HOURS[window] * 3600_000).toISOString();
}

export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 3600_000).toISOString();
}

export function windowNoun(window: Window): string {
  return { "24h": "in the last 24 hours", "7d": "in the last 7 days", "30d": "in the last 30 days" }[window];
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
