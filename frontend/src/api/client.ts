// Central HTTP client. One place for the base URL, the Authorization header, error normalisation,
// session expiry (401) and the single safe retry for lock-timeout conflicts.
import { clearSession, getToken, notifyUnauthorized } from '../auth/session';
import type { Envelope } from './types';

// Development: same-origin "/api" (Vite proxies to the backend, so no CORS is needed).
// Production build: VITE_API_BASE_URL (a public address; the backend must list this site in CORS_ORIGINS).
const BASE: string = import.meta.env.DEV
  ? ''
  : String(import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;

  constructor(
    status: number, code: string, message: string,
    extra: { details?: unknown; requestId?: string; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = extra.details;
    this.requestId = extra.requestId;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  /** Attach the bearer token (default). Login/registration pass false and never trigger session expiry. */
  auth?: boolean;
  /**
   * A public read-only route. If a stored token turns out to be rejected, the session is dropped and
   * the read is repeated once anonymously, so browsing never breaks because a session ended.
   */
  public?: boolean;
}

function buildUrl(path: string, query?: Query): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return `${BASE}${path}${s ? `?${s}` : ''}`;
}

/** Retryable only because the backend aborted the operation before changing anything. */
const RETRYABLE_CODES = new Set(['RESOURCE_BUSY', 'RETRY']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attempt<T>(path: string, o: RequestOptions): Promise<Envelope<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = o.auth === false ? null : getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(buildUrl(path, o.query), {
      method: o.method ?? 'GET',
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      signal: o.signal,
    });
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'We could not reach the BookLoop server. Check your connection and try again.');
  }

  let json: unknown = null;
  const text = await res.text();
  if (text) {
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  }

  if (res.ok) return (json ?? { data: null }) as Envelope<T>;

  const err = (json as { error?: { code?: string; message?: string; details?: unknown; requestId?: string } } | null)?.error;
  const retryAfter = Number(res.headers.get('retry-after'));
  const message = res.status >= 500
    ? 'Something went wrong on our side. Please try again in a moment.'
    : err?.message ?? 'The request could not be completed.';

  if (res.status === 401 && o.auth !== false && token) {
    clearSession();
    notifyUnauthorized();
  }
  throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, message, {
    details: err?.details,
    requestId: err?.requestId,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  });
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
  try {
    return await attempt<T>(path, options);
  } catch (e) {
    if (options.public && e instanceof ApiError && e.status === 401 && options.auth !== false) {
      return api<T>(path, { ...options, auth: false });
    }
    // At most ONE automatic retry, and only for lock-timeout conflicts. The server rolled the
    // transaction back before any change was made, so repeating the call cannot duplicate an action.
    if (e instanceof ApiError && RETRYABLE_CODES.has(e.code)) {
      await sleep(Math.min(e.retryAfterSeconds ?? 1, 3) * 1000);
      return attempt<T>(path, options);
    }
    throw e;
  }
}
