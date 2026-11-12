"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const POLL_MS = 5000;

interface State<T> {
  key: string | null;
  data?: T;
  error?: Error;
  updatedAt?: Date;
}

/**
 * Fetch data for `key` and refetch when the key changes or refresh() is called.
 * Polls every 5 s only while `pollWhile` says so: for example while a run is evaluating,
 * or always on the Today page. Stops when the component unmounts or the page is hidden
 * (Next.js hides pages you navigate away from, which runs the cleanup below).
 * A null key means "don't fetch yet".
 */
export function useResource<T>(
  key: string | null,
  load: () => Promise<T>,
  pollWhile?: (data: T | undefined) => boolean,
) {
  const [state, setState] = useState<State<T>>({ key: null });
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);
  const pollRef = useRef(pollWhile);
  useEffect(() => {
    loadRef.current = load;
    pollRef.current = pollWhile;
  });

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function fetchOnce() {
      let data: T | undefined;
      try {
        data = await loadRef.current();
        if (cancelled) return;
        setState({ key, data, updatedAt: new Date() });
      } catch (error) {
        if (cancelled) return;
        setState((previous) => ({
          ...(previous.key === key ? previous : { key }),
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      }
      if (!cancelled && pollRef.current?.(data)) timer = setTimeout(fetchOnce, POLL_MS);
    }

    fetchOnce();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const current = state.key === key;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    updatedAt: current ? state.updatedAt : undefined,
    loading: !current || (state.data === undefined && state.error === undefined),
    refresh,
  };
}
