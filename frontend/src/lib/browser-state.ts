"use client";

/**
 * Small pieces of state that live in the browser: the theme and the reviewer's name.
 * Read with useSyncExternalStore so the server render and the first client render agree.
 */

import { useCallback, useSyncExternalStore } from "react";
import { THEME_KEY } from "./constants";

// ---------- "Something changed" signal: a review or resolution was saved ----------

const CHANGED = "agent-eval:changed";

export function announceChange() {
  window.dispatchEvent(new Event(CHANGED));
}

export function onChange(callback: () => void) {
  window.addEventListener(CHANGED, callback);
  return () => window.removeEventListener(CHANGED, callback);
}

// ---------- Saved text, e.g. the reviewer's name ----------

const STORED = "agent-eval:stored";

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function subscribeStored(callback: () => void) {
  window.addEventListener(STORED, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(STORED, callback);
    window.removeEventListener("storage", callback);
  };
}

export function useStoredText(key: string, fallback: string): [string, (value: string) => void] {
  const value = useSyncExternalStore(
    subscribeStored,
    () => readStored(key) ?? fallback,
    () => fallback,
  );
  const setValue = useCallback(
    (next: string) => {
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // private mode or blocked storage: the name just isn't remembered
      }
      window.dispatchEvent(new Event(STORED));
    },
    [key],
  );
  return [value, setValue];
}

// ---------- Theme: a "dark" class on <html>, set before paint by the script in layout.tsx ----------

function subscribeTheme(callback: () => void) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

export function useDarkTheme(): [boolean, () => void] {
  const dark = useSyncExternalStore(
    subscribeTheme,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
  const toggle = useCallback(() => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      window.localStorage.setItem(THEME_KEY, next ? "dark" : "light");
    } catch {
      // not remembered, still switched
    }
  }, []);
  return [dark, toggle];
}
