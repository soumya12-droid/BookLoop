import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, onUnauthorized, saveSession } from '../auth/session';
import { api, ApiError } from './client';

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

function mockFetch(...replies: (Reply | Error)[]) {
  const fn = vi.fn(async () => {
    const r = replies.shift();
    if (!r) throw new Error('unexpected extra fetch call');
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const lastHeaders = (fn: ReturnType<typeof vi.fn>, call = 0) => (fn.mock.calls[call] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
const lastUrl = (fn: ReturnType<typeof vi.fn>, call = 0) => (fn.mock.calls[call] as unknown as [string])[0];

beforeEach(() => { clearSession(); vi.useRealTimers(); });
afterEach(() => { vi.unstubAllGlobals(); clearSession(); });

describe('api client', () => {
  it('returns the data/page envelope and builds the query string without empty values', async () => {
    const f = mockFetch({ status: 200, body: { data: [1], page: { limit: 5, offset: 0, total: 1 } } });
    const r = await api<number[]>('/api/books', { query: { q: 'dune', genreId: '', availableOnly: undefined, limit: 5 } });
    expect(r.data).toEqual([1]);
    expect(r.page?.total).toBe(1);
    expect(lastUrl(f)).toBe('/api/books?q=dune&limit=5');
  });

  it('sends the bearer token only when a session exists and auth is not disabled', async () => {
    saveSession('tok-123', 3600);
    const f = mockFetch({ status: 200, body: { data: null } }, { status: 200, body: { data: null } });
    await api('/api/auth/me');
    await api('/api/auth/login', { method: 'POST', body: { email: 'a', password: 'b' }, auth: false });
    expect(lastHeaders(f, 0).Authorization).toBe('Bearer tok-123');
    expect(lastHeaders(f, 1).Authorization).toBeUndefined();
    expect(lastHeaders(f, 1)['Content-Type']).toBe('application/json');
  });

  it('does not use an expired token', async () => {
    saveSession('old', 1);                         // 1 s lifetime minus the 5 s safety margin = already expired
    const f = mockFetch({ status: 200, body: { data: null } });
    await api('/api/auth/me');
    expect(lastHeaders(f).Authorization).toBeUndefined();
  });

  it('maps API error bodies to ApiError (validation, conflict, not found, forbidden, rate limit)', async () => {
    for (const [status, code] of [[400, 'VALIDATION_ERROR'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [409, 'COPY_UNAVAILABLE'], [429, 'RATE_LIMITED']] as const) {
      mockFetch({ status, body: { error: { code, message: `m-${code}`, details: [{ path: 'x', message: 'bad' }], requestId: 'r1' } } });
      const e = await api('/api/x').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect([err.status, err.code, err.message, err.requestId]).toEqual([status, code, `m-${code}`, 'r1']);
      expect(err.details).toEqual([{ path: 'x', message: 'bad' }]);
    }
  });

  it('turns a network failure into a friendly ApiError with status 0', async () => {
    mockFetch(new TypeError('fetch failed'));
    const e = (await api('/api/x').catch((x: unknown) => x)) as ApiError;
    expect(e.status).toBe(0);
    expect(e.code).toBe('NETWORK');
    expect(e.message).not.toMatch(/fetch failed/);
  });

  it('never exposes server error text for 5xx responses', async () => {
    mockFetch({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'SELECT * FROM users failed' } } });
    const e = (await api('/api/x').catch((x: unknown) => x)) as ApiError;
    expect(e.status).toBe(500);
    expect(e.message).not.toMatch(/SELECT|users/);
  });

  it('on 401 with a session: clears it and notifies once; on 401 without auth (login) it does not', async () => {
    saveSession('tok', 3600);
    const handler = vi.fn();
    const off = onUnauthorized(handler);
    mockFetch({ status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'x' } } });
    await api('/api/auth/me').catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);

    mockFetch({ status: 401, body: { error: { code: 'INVALID_CREDENTIALS', message: 'x' } } });
    await api('/api/auth/login', { method: 'POST', auth: false, body: {} }).catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    off();
  });

  it('retries exactly once on RESOURCE_BUSY, honouring Retry-After (capped)', async () => {
    vi.useFakeTimers();
    const busy: Reply = { status: 409, body: { error: { code: 'RESOURCE_BUSY', message: 'busy' } }, headers: { 'retry-after': '1' } };
    const f = mockFetch(busy, { status: 200, body: { data: { ok: true } } });
    const p = api<{ ok: boolean }>('/api/requests/1/approve', { method: 'POST' });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toEqual({ data: { ok: true } });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('gives up after one retry, and never retries other conflicts', async () => {
    vi.useFakeTimers();
    const busy: Reply = { status: 409, body: { error: { code: 'RESOURCE_BUSY', message: 'busy' } }, headers: { 'retry-after': '1' } };
    const f = mockFetch(busy, busy);
    const p = api('/api/x', { method: 'POST' }).catch((x: unknown) => x);
    await vi.advanceTimersByTimeAsync(1000);
    expect(((await p) as ApiError).code).toBe('RESOURCE_BUSY');
    expect(f).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    const g = mockFetch({ status: 409, body: { error: { code: 'INVALID_STATE', message: 'x' } } });
    await api('/api/x', { method: 'POST' }).catch(() => undefined);
    expect(g).toHaveBeenCalledTimes(1);
  });
});

describe('public reads', () => {
  it('a rejected token on a public read drops the session and repeats the read once, anonymously', async () => {
    saveSession('stale.token.value', 3600);
    const f = mockFetch(
      { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'no' } } },
      { status: 200, body: { data: [{ id: 'g' }] } },
    );
    const r = await api<unknown[]>('/api/genres', { public: true });
    expect(r.data).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(2);
    expect(lastHeaders(f, 0).Authorization).toBe('Bearer stale.token.value');
    expect(lastHeaders(f, 1).Authorization).toBeUndefined();
  });

  it('a protected call is never downgraded: its 401 still surfaces', async () => {
    saveSession('stale.token.value', 3600);
    const f = mockFetch({ status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'no' } } });
    await expect(api('/api/requests')).rejects.toMatchObject({ status: 401 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('anonymous public reads send no Authorization header', async () => {
    const f = mockFetch({ status: 200, body: { data: [] } });
    await api('/api/books', { public: true });
    expect(lastHeaders(f).Authorization).toBeUndefined();
  });
});
