// @vitest-environment jsdom
// Regression tests for "another account's / another view's data flashes on screen".
// Root causes covered: useAsync kept the previous result visible when its inputs (tab, page, token)
// changed, did not treat a new session as a new request, and page-local state (profile form, page
// offsets) outlived the identity or view it belonged to.
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api/client';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { clearSession, saveSession } from './auth/session';
import { useAsync } from './hooks/useAsync';
import Profile from './pages/Profile';

// ---------- controllable promises ----------
interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// ---------- fake API keyed by bearer token ----------
const USERS = {
  tokA: { id: 'user-a', email: 'a@example.test', displayName: 'Alice Account', role: 'MEMBER', contactInfo: 'A-CONTACT', defaultPickupLocation: 'A-LOBBY', createdAt: '2026-01-01T00:00:00.000Z' },
  tokB: { id: 'user-b', email: 'b@example.test', displayName: 'Bob Account', role: 'MEMBER', contactInfo: 'B-CONTACT', defaultPickupLocation: 'B-LOBBY', createdAt: '2026-01-01T00:00:00.000Z' },
} as const;
type Tok = keyof typeof USERS;

const request = (id: string, title: string, owner: string, requester: string) => ({
  id, status: 'PENDING', message: null, createdAt: '2026-03-01T00:00:00.000Z', decidedAt: null, cancelledAt: null,
  cancelledBy: null, copy: { id: `copy-${id}`, bookId: `book-${id}`, bookTitle: title },
  owner: { id: `o-${owner}`, displayName: owner }, requester: { id: `r-${requester}`, displayName: requester },
  loanId: null, counterpartyContact: null,
});
const page = (data: unknown[]) => ({ data, page: { limit: data.length, offset: 0, total: data.length } });

/** Per (token, path+query): either an immediate payload or a deferred one the test releases. */
type Handler = unknown | Deferred<unknown>;
let handlers: Record<string, Handler> = {};
let seen: { path: string; token: string | null }[] = [];

function installFetch() {
  seen = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    const auth = ((init.headers ?? {}) as Record<string, string>).Authorization ?? null;
    const token = auth ? auth.replace('Bearer ', '') : null;
    const full = url.pathname + url.search;
    seen.push({ path: full, token });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (url.pathname === '/api/auth/login' && init.method === 'POST') {
      const email = JSON.parse(String(init.body)).email as string;
      const tok: Tok = email.startsWith('b') ? 'tokB' : 'tokA';
      return json(200, { data: { user: USERS[tok], token: tok, tokenType: 'Bearer', expiresIn: 3600 } });
    }
    if (!token || !(token in USERS)) return json(401, { error: { code: 'UNAUTHENTICATED', message: 'no' } });
    if (url.pathname === '/api/auth/me') return json(200, { data: USERS[token as Tok] });

    const key = `${token}|${full}`;
    const h = handlers[key] ?? handlers[`${token}|${url.pathname}`];
    if (h === undefined) return json(200, page([]));
    const body = h instanceof Object && 'promise' in (h as object) ? await (h as Deferred<unknown>).promise : h;
    return json(200, body);
  }));
}

function renderApp(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

/** Records the visible text after every DOM mutation, so "never rendered" can be asserted. */
function recordText() {
  const snapshots: string[] = [];
  const obs = new MutationObserver(() => snapshots.push(document.body.textContent ?? ''));
  obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  return { snapshots, stop: () => obs.disconnect() };
}

beforeEach(() => {
  clearSession();
  window.scrollTo = vi.fn();
  handlers = {};
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearSession();
});

// =====================================================================================
describe('useAsync', () => {
  it('hides the previous inputs’ data as soon as the inputs change', async () => {
    const pending: Record<string, Deferred<string>> = { a: deferred(), b: deferred() };
    const { result, rerender } = renderHook(({ k }) => useAsync(() => pending[k]!.promise, [k]), { initialProps: { k: 'a' } });
    await act(async () => { pending.a!.resolve('data-for-a'); });
    expect(result.current.data).toBe('data-for-a');

    rerender({ k: 'b' });
    expect(result.current.data).toBeNull();     // never "data-for-a" under the new inputs
    expect(result.current.loading).toBe(true);

    await act(async () => { pending.b!.resolve('data-for-b'); });
    expect(result.current.data).toBe('data-for-b');
    expect(result.current.loading).toBe(false);
  });

  it('ignores an older request that finishes after a newer one', async () => {
    const pending: Record<string, Deferred<string>> = { a: deferred(), b: deferred() };
    // the fetcher ignores the abort signal, like a request that cannot be cancelled
    const { result, rerender } = renderHook(({ k }) => useAsync(() => pending[k]!.promise, [k]), { initialProps: { k: 'a' } });
    rerender({ k: 'b' });
    await act(async () => { pending.b!.resolve('newer'); });
    expect(result.current.data).toBe('newer');
    await act(async () => { pending.a!.resolve('older-and-late'); });
    expect(result.current.data).toBe('newer');
  });

  it('a late failure of an older request does not replace newer data or show an error', async () => {
    const a = deferred<string>(); const b = deferred<string>();
    const fns: Record<string, Deferred<string>> = { a, b };
    const { result, rerender } = renderHook(({ k }) => useAsync(() => fns[k]!.promise, [k]), { initialProps: { k: 'a' } });
    rerender({ k: 'b' });
    await act(async () => { b.resolve('newer'); });
    await act(async () => { a.promise.catch(() => undefined); });
    expect(result.current.data).toBe('newer');
    expect(result.current.error).toBeNull();
  });

  it('treats a new session (different token) as a new request and hides the old account’s data', async () => {
    saveSession('tokA', 3600);
    handlers['tokA|/api/requests'] = page([request('1', 'Alice-only book', 'x', 'Alice Account')]);
    const gateB = deferred<unknown>();
    handlers['tokB|/api/requests'] = gateB;

    const { result } = renderHook(() => useAsync((s) => api<unknown[]>('/api/requests', { signal: s }), []));
    await waitFor(() => expect(JSON.stringify(result.current.data)).toContain('Alice-only book'));

    await act(async () => { saveSession('tokB', 3600); });  // same mounted component, different account
    expect(JSON.stringify(result.current.data)).not.toContain('Alice-only book');
    expect(result.current.loading).toBe(true);

    await act(async () => { gateB.resolve(page([request('2', 'Bob-only book', 'x', 'Bob Account')])); });
    await waitFor(() => expect(JSON.stringify(result.current.data)).toContain('Bob-only book'));
    expect(seen.filter((c) => c.path === '/api/requests').map((c) => c.token)).toEqual(['tokA', 'tokB']);
  });

  it('keeps showing the same view’s data while an explicit reload is in flight (no empty flash)', async () => {
    const first = deferred<string>(); const second = deferred<string>();
    const queue = [first, second];
    const { result } = renderHook(() => useAsync(() => queue.shift()!.promise, []));
    await act(async () => { first.resolve('v1'); });
    act(() => result.current.reload());
    expect(result.current.data).toBe('v1');
    await act(async () => { second.resolve('v2'); });
    expect(result.current.data).toBe('v2');
  });
});

// =====================================================================================
describe('account pages', () => {
  it('My Requests: switching tab never shows the other tab’s records under the new tab', async () => {
    saveSession('tokA', 3600);
    const incoming = deferred<unknown>();
    handlers['tokA|/api/requests?role=requester&limit=10&offset=0'] = page([request('m1', 'MINE-ONLY-BOOK', 'Someone Else', 'Alice Account')]);
    handlers['tokA|/api/requests?role=owner&limit=10&offset=0'] = incoming;
    const u = userEvent.setup();
    renderApp('/my/requests');
    expect((await screen.findAllByText('MINE-ONLY-BOOK')).length).toBeGreaterThan(0);

    const rec = recordText();
    await u.click(screen.getByRole('tab', { name: 'Requests for my books' }));
    await waitFor(() => expect(screen.queryAllByText('MINE-ONLY-BOOK')).toHaveLength(0));
    expect(screen.getByRole('tab', { name: 'Requests for my books' }).getAttribute('aria-selected')).toBe('true');

    await act(async () => { incoming.resolve(page([request('i1', 'INCOMING-ONLY-BOOK', 'Alice Account', 'Carol Requester')])); });
    expect((await screen.findAllByText('INCOMING-ONLY-BOOK')).length).toBeGreaterThan(0);
    rec.stop();
    // after the switch began, the old tab's record was never on screen again
    const afterSwitch = rec.snapshots;
    expect(afterSwitch.every((t) => !t.includes('MINE-ONLY-BOOK'))).toBe(true);
  });

  it('My Requests: an older tab’s response arriving late does not overwrite the current tab', async () => {
    saveSession('tokA', 3600);
    const lateIncoming = deferred<unknown>();
    handlers['tokA|/api/requests?role=requester&limit=10&offset=0'] = page([request('m1', 'MINE-BOOK', 'Someone', 'Alice Account')]);
    handlers['tokA|/api/requests?role=owner&limit=10&offset=0'] = lateIncoming;
    const u = userEvent.setup();
    renderApp('/my/requests');
    await screen.findAllByText('MINE-BOOK');

    await u.click(screen.getByRole('tab', { name: 'Requests for my books' }));   // slow request starts
    await u.click(screen.getByRole('tab', { name: 'Requested by me' }));         // back to the first view
    expect((await screen.findAllByText('MINE-BOOK')).length).toBeGreaterThan(0);

    const rec = recordText();
    await act(async () => { lateIncoming.resolve(page([request('i1', 'LATE-INCOMING-BOOK', 'Alice Account', 'Carol')])); });
    rec.stop();
    expect(screen.queryAllByText('LATE-INCOMING-BOOK')).toHaveLength(0);
    expect(rec.snapshots.every((t) => !t.includes('LATE-INCOMING-BOOK'))).toBe(true);
    expect(screen.getAllByText('MINE-BOOK').length).toBeGreaterThan(0);
  });

  it('Profile: the form follows the signed-in account when the account changes under it', async () => {
    saveSession('tokA', 3600);
    function SwitchToBob() {
      const { signIn } = useAuth();
      return <button onClick={() => void signIn('bob@example.test', 'pw')}>switch</button>;
    }
    render(
      <MemoryRouter><AuthProvider><Profile /><SwitchToBob /></AuthProvider></MemoryRouter>,
    );
    await waitFor(() => expect((screen.getByLabelText(/display name/i) as HTMLInputElement).value).toBe('Alice Account'));
    expect(screen.getByText('a@example.test')).toBeTruthy();

    await userEvent.setup().click(screen.getByRole('button', { name: 'switch' }));
    await waitFor(() => expect(screen.getByText('b@example.test')).toBeTruthy());
    expect((screen.getByLabelText(/display name/i) as HTMLInputElement).value).toBe('Bob Account');
    expect((screen.getByLabelText(/contact details/i) as HTMLInputElement).value).toBe('B-CONTACT');
    expect(screen.queryByText('a@example.test')).toBeNull();
  });

  it('signing out and signing in as someone else never shows the first account’s data to the second', async () => {
    saveSession('tokA', 3600);
    handlers['tokA|/api/requests?role=requester&limit=10&offset=0'] = page([request('a1', 'ALICE-PRIVATE-BOOK', 'Owner', 'Alice Account')]);
    handlers['tokB|/api/requests?role=requester&limit=10&offset=0'] = page([request('b1', 'BOB-BOOK', 'Owner', 'Bob Account')]);
    const u = userEvent.setup();
    renderApp('/my/requests');
    expect((await screen.findAllByText('ALICE-PRIVATE-BOOK')).length).toBeGreaterThan(0);

    // sign out through the menu
    await u.click(await screen.findByRole('button', { name: /Account menu for Alice Account/ }));
    await u.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await screen.findAllByRole('link', { name: 'Sign in' });

    const rec = recordText();
    await u.click(screen.getAllByRole('link', { name: 'Sign in' })[0]!);
    await u.type(await screen.findByLabelText(/email/i), 'bob@example.test');
    await u.type(screen.getByLabelText(/password/i), 'a-long-password');
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    await u.click((await screen.findAllByRole('link', { name: 'My Requests' }))[0]!);

    expect((await screen.findAllByText('BOB-BOOK')).length).toBeGreaterThan(0);
    rec.stop();
    expect(rec.snapshots.every((t) => !t.includes('ALICE-PRIVATE-BOOK') && !t.includes('a@example.test') && !t.includes('A-CONTACT'))).toBe(true);
    // every account-specific request after the switch carried Bob's token
    const afterLogin = seen.slice(seen.findIndex((c) => c.path === '/api/auth/login') + 1);
    expect(afterLogin.filter((c) => c.path.startsWith('/api/requests')).every((c) => c.token === 'tokB')).toBe(true);
    void within;
  });
});
