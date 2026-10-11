// Derives the Neon *pooled* (PgBouncer, transaction mode) connection string for the TEST endpoint
// from DATABASE_URL_TEST by inserting "-pooler" after the endpoint id. It cannot point at any other
// endpoint or database. The returned string contains credentials: never print it.
import { testTarget } from './env.mjs';

export function testPooledUrl() {
  const { url } = testTarget();               // enforces: direct URL, not the dev endpoint
  const u = new URL(url);
  const [first, ...rest] = u.hostname.split('.');
  if (first.endsWith('-pooler')) throw new Error('DATABASE_URL_TEST is already a pooled URL');
  u.hostname = [`${first}-pooler`, ...rest].join('.');
  return u.toString();
}
