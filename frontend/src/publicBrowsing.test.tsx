// @vitest-environment jsdom
// Anonymous browsing: the catalogue pages render and fetch WITHOUT a token, and every borrowing
// action sends a visitor to sign in with a `next` destination that brings them back afterwards.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { clearSession, saveSession } from './auth/session';

const BOOK_ID = '11111111-1111-4111-8111-111111111111';
const COPY_ID = '22222222-2222-4222-8222-222222222222';
const GENRE_ID = '33333333-3333-4333-8333-333333333333';

const book = {
  id: BOOK_ID, title: 'The Lantern Keeper', isbn: null, edition: null, publisher: null, publicationYear: 2019,
  description: 'A quiet story about light.', createdAt: '2026-01-01T00:00:00.000Z',
  authors: [{ id: 'a1', name: 'Mira Okafor' }], genres: [{ id: GENRE_ID, name: 'Fiction' }],
  availableCopies: 1, reviewCount: 1, averageRating: 4,
};
const publicCopy = {
  id: COPY_ID, bookId: BOOK_ID, bookTitle: book.title, owner: { displayName: 'Priya S' }, condition: 'GOOD',
  isListed: true, pickupLocation: null, notes: null, available: true, createdAt: '2026-01-02T00:00:00.000Z',
};
const user = {
  id: 'u1', email: 'reader@example.test', displayName: 'Reader One', role: 'MEMBER',
  contactInfo: null, defaultPickupLocation: null, createdAt: '2026-01-01T00:00:00.000Z',
};

interface Call { path: string; method: string; authorization: string | null }
let calls: Call[] = [];

/** A tiny fake API. Protected routes answer 401 without a bearer token, as the real one does. */
function installFakeApi() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    const headers = (init.headers ?? {}) as Record<string, string>;
    const authorization = headers.Authorization ?? null;
    const method = init.method ?? 'GET';
    calls.push({ path: url.pathname, method, authorization });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const page = (data: unknown[]) => ({ data, page: { limit: data.length, offset: 0, total: data.length } });
    const p = url.pathname;

    if (p === '/api/genres') return json(200, { data: [{ id: GENRE_ID, name: 'Fiction' }] });
    if (p === '/api/books') return json(200, page([book]));
    if (p === `/api/books/${BOOK_ID}`) return json(200, { data: book });
    if (p === `/api/books/${BOOK_ID}/copies`) return json(200, { data: [publicCopy] });
    if (p === `/api/books/${BOOK_ID}/reviews`) {
      return json(200, page([{ id: 'r1', rating: 4, comment: 'Lovely', createdAt: '2026-02-01T00:00:00.000Z', reviewerName: 'Sam' }]));
    }
    if (p === '/api/auth/login' && method === 'POST') {
      return json(200, { data: { user, token: 'tok.en.value', tokenType: 'Bearer', expiresIn: 3600 } });
    }
    if (!authorization) {
      return json(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
    }
    if (p === '/api/auth/me') return json(200, { data: user });
    if (p === '/api/requests' || p === '/api/loans') return json(200, page([]));
    if (p === '/api/users/me/copies') return json(200, { data: [] });
    return json(404, { error: { code: 'NOT_FOUND', message: 'No such route' } });
  }));
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider><App /></AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clearSession();
  window.scrollTo = vi.fn();
  installFakeApi();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearSession();
});

describe('public browsing without signing in', () => {
  it('Discover shows books and genres, calling only public endpoints with no token', async () => {
    renderAt('/');
    expect(await screen.findAllByText('The Lantern Keeper')).not.toHaveLength(0);
    expect(await screen.findAllByText('Fiction')).not.toHaveLength(0);
    expect(screen.queryByText('Welcome back')).toBeNull();
    const paths = new Set(calls.map((c) => c.path));
    expect([...paths].every((p) => p === '/api/books' || p === '/api/genres')).toBe(true);
    expect(calls.every((c) => c.authorization === null)).toBe(true);
  });

  it('the catalogue page renders for an anonymous visitor', async () => {
    renderAt('/books');
    expect((await screen.findAllByText('The Lantern Keeper')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Welcome back')).toBeNull();
    expect(calls.some((c) => c.path === '/api/books')).toBe(true);
    expect(calls.every((c) => c.authorization === null)).toBe(true);
  });

  it('the genres page renders for an anonymous visitor', async () => {
    renderAt('/genres');
    expect((await screen.findAllByText('Fiction')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Welcome back')).toBeNull();
  });

  it('book detail shows the book, its copies and reviews, and never asks for the visitor’s requests', async () => {
    renderAt(`/books/${BOOK_ID}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'The Lantern Keeper' })).toBeTruthy();
    expect(await screen.findByText('Shared by Priya S')).toBeTruthy();
    expect(await screen.findByText('Lovely')).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/requests')).toBe(false);
    expect(calls.every((c) => c.authorization === null)).toBe(true);
  });

  it('a missing book shows a friendly not-found state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'BOOK_NOT_FOUND', message: 'Book not found' } }),
      { status: 404, headers: { 'content-type': 'application/json' } })));
    renderAt('/books/99999999-9999-4999-8999-999999999999');
    expect(await screen.findByText('We couldn’t find that book')).toBeTruthy();
  });

  it('the navigation does not offer member-only pages to an anonymous visitor', async () => {
    renderAt('/books');
    await screen.findAllByText('The Lantern Keeper');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByText('Discover')).toBeTruthy();
    expect(within(nav).getByText('Genres')).toBeTruthy();
    expect(within(nav).queryByText('My Loans')).toBeNull();
    expect(within(nav).queryByText('My Requests')).toBeNull();
  });
});

describe('borrowing needs an account', () => {
  it('"Sign in to borrow" goes to login with next, and signing in returns to the same book', async () => {
    const u = userEvent.setup();
    renderAt(`/books/${BOOK_ID}`);
    const link = await screen.findByRole('link', { name: 'Sign in to borrow' });
    expect(link.getAttribute('href')).toBe(`/login?next=${encodeURIComponent(`/books/${BOOK_ID}`)}`);
    await u.click(link);

    expect(await screen.findByText('Welcome back')).toBeTruthy();
    await u.type(screen.getByLabelText(/email/i), 'reader@example.test');
    await u.type(screen.getByLabelText(/password/i), 'correct-horse-battery');
    await u.click(screen.getByRole('button', { name: 'Sign in' }));

    // back on the book, now able to request the copy; the token is sent from here on
    expect(await screen.findByRole('button', { name: 'Request to borrow' })).toBeTruthy();
    expect(screen.queryByText('Welcome back')).toBeNull();
    await waitFor(() => expect(calls.some((c) => c.path === '/api/requests' && c.authorization === 'Bearer tok.en.value')).toBe(true));
  });

  it('member-only pages still send an anonymous visitor to login, remembering where they were going', async () => {
    renderAt('/my/loans');
    expect(await screen.findByText('Welcome back')).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/loans')).toBe(false);
  });

  it('an already signed-in member sees the request button straight away', async () => {
    saveSession('tok.en.value', 3600);
    renderAt(`/books/${BOOK_ID}`);
    expect(await screen.findByRole('button', { name: 'Request to borrow' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Sign in to borrow' })).toBeNull();
  });
});

describe('footer', () => {
  it('offers join/sign-in, not member-only links, to an anonymous visitor', async () => {
    renderAt('/genres');
    await screen.findAllByText('Fiction');
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByRole('link', { name: 'Create an account' })).toBeTruthy();
    expect(within(footer).getByRole('link', { name: 'Sign in' })).toBeTruthy();
    for (const name of ['My Books', 'My Requests', 'My Loans', 'Profile', 'Share a book']) {
      expect(within(footer).queryByRole('link', { name })).toBeNull();
    }
  });

  it('shows account links to a signed-in member', async () => {
    saveSession('tok.en.value', 3600);
    renderAt('/genres');
    await screen.findAllByText('Fiction');
    const footer = screen.getByRole('contentinfo');
    expect(await within(footer).findByRole('link', { name: 'My Loans' })).toBeTruthy();
    expect(within(footer).getByRole('link', { name: 'Share a book' })).toBeTruthy();
    expect(within(footer).queryByRole('link', { name: 'Create an account' })).toBeNull();
  });
});
