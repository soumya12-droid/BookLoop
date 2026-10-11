import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';

export interface AsyncState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

interface Result<T> { key: string; data: T | null; error: ApiError | null }

/**
 * Runs `fn` on mount and whenever `deps` (primitives) change. Stale responses are ignored and
 * in-flight requests are aborted. `reload()` re-runs it without clearing the visible data, so a
 * refresh after an action does not flash an empty page.
 */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<Result<T> | null>(null);
  const key = `${JSON.stringify(deps)}#${tick}`;

  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; }); // declared first: runs before the fetch effect below

  useEffect(() => {
    const ctrl = new AbortController();
    fnRef.current(ctrl.signal).then(
      (data) => { if (!ctrl.signal.aborted) setResult({ key, data, error: null }); },
      (e: unknown) => {
        if (ctrl.signal.aborted || (e as { name?: string })?.name === 'AbortError') return;
        const error = e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Something went wrong.');
        setResult((prev) => ({ key, data: prev?.data ?? null, error }));
      },
    );
    return () => ctrl.abort();
  }, [key]);

  const current = result !== null && result.key === key;
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return {
    data: result?.data ?? null,           // stale data stays visible while a refresh is in flight
    error: current ? result.error : null,
    loading: !current,
    reload,
  };
}
