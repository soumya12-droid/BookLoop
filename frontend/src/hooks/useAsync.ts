import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError } from '../api/client';
import { sessionEpoch, subscribeSessionEpoch } from '../auth/session';

export interface AsyncState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/** `scope` is what the data is *about* (inputs + session); `key` additionally counts reloads. */
interface Result<T> { scope: string; key: string; data: T | null; error: ApiError | null }

/**
 * Runs `fn` on mount and whenever `deps` (primitives) or the signed-in session change.
 *
 * - Data is only ever returned for the scope it was fetched for. When the inputs (tab, page, id) or
 *   the session (token) change, the previous data is hidden at once and `loading` is true until the
 *   new response arrives, so one view or account never shows another's records.
 * - `reload()` re-runs the same scope without hiding it, so a refresh after an action does not flash
 *   an empty page; that data is still the same account's, for the same query.
 * - A response that is no longer the latest request is ignored (the request is aborted, and the
 *   handlers also refuse to write once their effect has been cleaned up), so a slow older response
 *   can neither replace newer data nor raise a stale error.
 */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const epoch = useSyncExternalStore(subscribeSessionEpoch, sessionEpoch, sessionEpoch);
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<Result<T> | null>(null);
  const scope = `${epoch}|${JSON.stringify(deps)}`;
  const key = `${scope}#${tick}`;

  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; }); // declared first: runs before the fetch effect below

  useEffect(() => {
    const ctrl = new AbortController();
    fnRef.current(ctrl.signal).then(
      (data) => { if (!ctrl.signal.aborted) setResult({ scope, key, data, error: null }); },
      (e: unknown) => {
        if (ctrl.signal.aborted || (e as { name?: string })?.name === 'AbortError') return;
        const error = e instanceof ApiError ? e : new ApiError(0, 'UNKNOWN', 'Something went wrong.');
        // Keep earlier data only if it belongs to this same scope (a failed reload).
        setResult((prev) => ({ scope, key, data: prev && prev.scope === scope ? prev.data : null, error }));
      },
    );
    return () => ctrl.abort();
  }, [scope, key]);

  const inScope = result !== null && result.scope === scope;
  const current = result !== null && result.key === key;
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return {
    data: inScope ? result.data : null,
    error: current ? result.error : null,
    loading: !current,
    reload,
  };
}
