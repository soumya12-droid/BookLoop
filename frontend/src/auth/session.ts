// Session storage for the access token.
//
// The backend issues a short-lived (1 h) bearer token and has no refresh or logout endpoint, so
// "logout" means discarding the token here. It is kept in sessionStorage (cleared when the tab
// closes, not shared across tabs) rather than localStorage to limit its lifetime. The token is never
// logged, rendered or put in a URL.
const KEY = 'bookloop.session';

interface Stored { token: string; expiresAt: number }

// A tiny in-memory fallback keeps the app working when storage is unavailable (private mode, tests).
let memory: Stored | null = null;

function read(): Stored | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(KEY);
    if (raw) return JSON.parse(raw) as Stored;
  } catch {
    /* fall through to memory */
  }
  return memory;
}

// Bumped whenever the stored token changes (sign-in, sign-up, sign-out, expiry). Data fetched under
// one session is never valid under another, so hooks include this in their request identity.
let epoch = 0;
const epochListeners = new Set<() => void>();
function bumpEpoch(): void {
  epoch += 1;
  // Deferred: getToken() can expire a session while a component is rendering.
  queueMicrotask(() => epochListeners.forEach((l) => l()));
}
export const sessionEpoch = (): number => epoch;
export function subscribeSessionEpoch(listener: () => void): () => void {
  epochListeners.add(listener);
  return () => { epochListeners.delete(listener); };
}

export function saveSession(token: string, expiresInSeconds: number): void {
  bumpEpoch();
  const s: Stored = { token, expiresAt: Date.now() + Math.max(0, expiresInSeconds - 5) * 1000 };
  memory = s;
  try {
    globalThis.sessionStorage?.setItem(KEY, JSON.stringify(s));
  } catch {
    /* memory only */
  }
}

export function clearSession(): void {
  if (read() !== null) bumpEpoch();
  memory = null;
  try {
    globalThis.sessionStorage?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Returns the token if present and not expired; an expired token is discarded. */
export function getToken(): string | null {
  const s = read();
  if (!s) return null;
  if (Date.now() >= s.expiresAt) {
    clearSession();
    return null;
  }
  return s.token;
}

// ---- "your session ended" broadcast (401 from any request) ----
const bus = new EventTarget();
export function notifyUnauthorized(): void {
  bus.dispatchEvent(new Event('unauthorized'));
}
export function onUnauthorized(handler: () => void): () => void {
  bus.addEventListener('unauthorized', handler);
  return () => bus.removeEventListener('unauthorized', handler);
}
