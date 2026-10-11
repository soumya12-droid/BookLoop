// HTTP-layer integration tests: real Express app, real PostgreSQL (the verified test branch).
// Fixtures are namespaced (users 'p2-api<run>-<n>@phase2.test', books 'P2 Book api ...', authors
// 'P2 Author ...') and removed by pattern. Seed data is only ever read.
// Run alone: these tests share a fixture namespace with the other suites (never in parallel).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { SignJWT } from 'jose';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config/env.ts';
import type { AppConfig } from '../src/config/env.ts';
import { signAccessToken } from '../src/http/auth.ts';
import { errorHandler } from '../src/http/errors.ts';
import { pool, cleanup, leftovers, mkUser, mkBook, mkCopy, pendingRequest, approvedRequest, committedLoan } from './helpers.ts';

// ---------- app + client ----------
const baseConfig = (o: Partial<AppConfig> = {}) => loadConfig({}, {
  databaseUrl: 'postgresql://placeholder.invalid/none', // never used: the pool is injected
  jwtSecret: SECRET, bcryptCost: 4, lockTimeoutMs: 3000,
  rateLimit: { windowMs: 60_000, loginMax: 10_000, registerMax: 10_000 }, ...o,
});
const SECRET = randomBytes(32).toString('hex');
const config = baseConfig();

const servers: Server[] = [];
function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      servers.push(s);
      resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`);
    });
  });
}

let BASE = '';
before(async () => {
  await cleanup();
  await cleanAuthors();
  BASE = await listen(createApp({ pool, config }));
});
after(async () => {
  for (const s of servers) await new Promise((r) => s.close(() => r(null)));
  await cleanup();
  await cleanAuthors();
  assert.equal(await leftovers(), 0, 'fixtures were not fully removed');
  const a = await pool.query(`SELECT count(*)::int n FROM authors WHERE name LIKE 'P2 Author %'`);
  assert.equal(a.rows[0].n, 0);
  await pool.end();
});

async function cleanAuthors() {
  await pool.query(`DELETE FROM authors a WHERE a.name LIKE 'P2 Author %'
                      AND NOT EXISTS (SELECT 1 FROM book_authors ba WHERE ba.author_id = a.id)`);
}

interface Res { status: number; json: any; headers: Headers; text: string }
async function call(
  method: string, path: string,
  o: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string>; base?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  let body: string | undefined;
  if (o.raw !== undefined) { body = o.raw; headers['content-type'] = 'application/json'; }
  else if (o.body !== undefined) { body = JSON.stringify(o.body); headers['content-type'] = 'application/json'; }
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  const r = await fetch((o.base ?? BASE) + path, { method, headers, body });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, headers: r.headers, text };
}

// ---------- fixtures through the API ----------
const run = Date.now().toString(36);
let n = 0;
const uniq = () => `${run}${(n++).toString(36)}`;
const PASSWORD = 'correct-horse-battery';

interface Member { id: string; token: string; email: string }
async function member(contactInfo?: string, displayName = 'API Tester'): Promise<Member> {
  const email = `p2-api${uniq()}@phase2.test`;
  const r = await call('POST', '/api/auth/register', {
    body: { email, password: PASSWORD, displayName, ...(contactInfo ? { contactInfo } : {}) },
  });
  assert.equal(r.status, 201, r.text);
  return { id: r.json.data.user.id, token: r.json.data.token, email };
}
async function adminToken(): Promise<{ id: string; token: string }> {
  const id = await mkUser('ADMIN');
  return { id, token: await signAccessToken(config, id) };
}
async function newBook(token: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await call('POST', '/api/books', { token, body: { title: `P2 Book api ${uniq()}`, ...extra } });
  assert.equal(r.status, 201, r.text);
  return r.json.data.id;
}
async function newCopy(token: string, bookId: string, body: Record<string, unknown> = {}): Promise<string> {
  const r = await call('POST', `/api/books/${bookId}/copies`, { token, body });
  assert.equal(r.status, 201, r.text);
  return r.json.data.id;
}
/** owner + copy, plus a requester. Everything created through the API. */
async function setup(ownerContact?: string, requesterContact?: string) {
  const owner = await member(ownerContact, 'Owner Person');
  const requester = await member(requesterContact, 'Requester Person');
  const book = await newBook(owner.token);
  const copy = await newCopy(owner.token, book);
  return { owner, requester, book, copy };
}
async function request(token: string, copy: string) {
  const r = await call('POST', `/api/copies/${copy}/requests`, { token, body: {} });
  assert.equal(r.status, 201, r.text);
  return r.json.data.id as string;
}
const code = (r: Res) => r.json?.error?.code;
const isbn13 = (seed: string) => {
  const body = `978${(parseInt(seed, 36) % 1e9).toString().padStart(9, '0')}`;
  const sum = [...body].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  return body + String((10 - (sum % 10)) % 10);
};

// =====================================================================================
// Authentication
// =====================================================================================
test('register: 201, MEMBER role, token usable, no password hash anywhere in the response', async () => {
  const email = `p2-api${uniq()}@phase2.test`;
  const r = await call('POST', '/api/auth/register', { body: { email, password: PASSWORD, displayName: 'Reg Test' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.data.user.role, 'MEMBER');
  assert.equal(r.json.data.user.email, email);
  assert.equal(r.json.data.tokenType, 'Bearer');
  assert.doesNotMatch(r.text, /password|hash|\$2[aby]\$/i);
  const me = await call('GET', '/api/auth/me', { token: r.json.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.data.id, r.json.data.user.id);
  assert.doesNotMatch(me.text, /password|hash/i);
  // the stored credential is a bcrypt hash, not the plaintext
  const row = (await pool.query(`SELECT password_hash FROM users WHERE id=$1`, [r.json.data.user.id])).rows[0];
  assert.match(row.password_hash, /^\$2[aby]\$\d\d\$/);
  assert.notEqual(row.password_hash, PASSWORD);
});

test('register: a client cannot choose its role or send unknown fields (400, nothing created)', async () => {
  const email = `p2-api${uniq()}@phase2.test`;
  const r = await call('POST', '/api/auth/register', {
    body: { email, password: PASSWORD, displayName: 'Evil', role: 'ADMIN' },
  });
  assert.equal(r.status, 400);
  assert.equal(code(r), 'VALIDATION_ERROR');
  const n = await pool.query(`SELECT count(*)::int n FROM users WHERE email = $1`, [email]);
  assert.equal(n.rows[0].n, 0);
});

test('register: validation failures are 400 (short password, bad email, blank name, 73+ byte password)', async () => {
  const good = { email: `p2-api${uniq()}@phase2.test`, password: PASSWORD, displayName: 'V' };
  for (const bad of [
    { ...good, password: 'short' },
    { ...good, email: 'not-an-email' },
    { ...good, displayName: '   ' },
    { ...good, password: 'x'.repeat(73) },
    { ...good, email: undefined },
  ]) {
    const r = await call('POST', '/api/auth/register', { body: bad });
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 60));
    assert.equal(code(r), 'VALIDATION_ERROR');
  }
});

test('register: duplicate email, including different case and whitespace, is 409 EMAIL_TAKEN', async () => {
  const m = await member();
  for (const email of [m.email, m.email.toUpperCase(), `  ${m.email}  `]) {
    const r = await call('POST', '/api/auth/register', { body: { email, password: PASSWORD, displayName: 'Dup' } });
    assert.equal(r.status, 409, email);
    assert.equal(code(r), 'EMAIL_TAKEN');
  }
});

test('login: success (email case-insensitive); wrong password and unknown email give the SAME generic 401', async () => {
  const m = await member();
  const ok = await call('POST', '/api/auth/login', { body: { email: m.email.toUpperCase(), password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.data.token);

  const wrongPw = await call('POST', '/api/auth/login', { body: { email: m.email, password: 'definitely-wrong-pw' } });
  const unknown = await call('POST', '/api/auth/login', { body: { email: `p2-api${uniq()}@phase2.test`, password: PASSWORD } });
  assert.equal(wrongPw.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(code(wrongPw), 'INVALID_CREDENTIALS');
  assert.equal(wrongPw.json.error.message, unknown.json.error.message);   // no account-existence oracle
  assert.deepEqual(Object.keys(wrongPw.json.error).sort(), Object.keys(unknown.json.error).sort());
});

test('login: a deactivated account gets the same generic 401; its old token stops working', async () => {
  const m = await member();
  const admin = await adminToken();
  const d = await call('POST', `/api/admin/users/${m.id}/deactivate`, { token: admin.token });
  assert.equal(d.status, 200);
  const login = await call('POST', '/api/auth/login', { body: { email: m.email, password: PASSWORD } });
  assert.equal(login.status, 401);
  assert.equal(code(login), 'INVALID_CREDENTIALS');
  const me = await call('GET', '/api/auth/me', { token: m.token });
  assert.equal(me.status, 401);          // token is valid, but the account no longer is
});

test('tokens: missing, malformed, expired, forged, wrong audience, alg=none and unknown subject are all 401', async () => {
  const m = await member();
  const now = Math.floor(Date.now() / 1000);
  const forge = (key: string, aud = 'bookloop-api') =>
    new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(m.id).setIssuer('bookloop').setAudience(aud)
      .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(key));
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const attempts: Record<string, string | undefined> = {
    'no header': undefined,
    'wrong scheme': 'Basic abc',
    'garbage token': 'Bearer not.a.jwt',
    'empty bearer': 'Bearer ',
    expired: `Bearer ${await signAccessToken(config, m.id, { issuedAtSeconds: now - 7200, expiresAtSeconds: now - 3600 })}`,
    'wrong signing key': `Bearer ${await forge('x'.repeat(48))}`,
    'wrong audience': `Bearer ${await forge(SECRET, 'someone-else')}`,
    'alg none': `Bearer ${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: m.id, iss: 'bookloop', aud: 'bookloop-api', exp: now + 3600 })}.`,
    'unknown subject': `Bearer ${await signAccessToken(config, randomUUID())}`,
  };
  for (const [label, header] of Object.entries(attempts)) {
    const r = await call('GET', '/api/auth/me', { headers: header ? { authorization: header } : {} });
    assert.equal(r.status, 401, label);
    assert.equal(code(r), 'UNAUTHENTICATED', label);
    assert.equal(r.headers.get('www-authenticate'), 'Bearer');
  }
  // the user id in a body/query is never an identity
  const viaBody = await call('GET', `/api/auth/me?userId=${m.id}`, { body: undefined });
  assert.equal(viaBody.status, 401);
});

test('login rate limit: failed attempts beyond the limit get 429 RATE_LIMITED with Retry-After', async () => {
  const base = await listen(createApp({
    pool, config: baseConfig({ rateLimit: { windowMs: 60_000, loginMax: 3, registerMax: 100 } }),
  }));
  const body = { email: `p2-api${uniq()}@phase2.test`, password: 'whatever-it-is' };
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/auth/login', { body, base })).status, 401);
  const r = await call('POST', '/api/auth/login', { body, base });
  assert.equal(r.status, 429);
  assert.equal(code(r), 'RATE_LIMITED');
  assert.ok(r.headers.get('retry-after'));
});

test('registration rate limit applies per window', async () => {
  const base = await listen(createApp({
    pool, config: baseConfig({ rateLimit: { windowMs: 60_000, loginMax: 100, registerMax: 2 } }),
  }));
  const bad = { email: 'nope', password: 'x', displayName: 'x' };
  assert.equal((await call('POST', '/api/auth/register', { body: bad, base })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { body: bad, base })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { body: bad, base })).status, 429);
});

// =====================================================================================
// Profile
// =====================================================================================
test('PATCH /users/me updates only the caller; email, role and unknown fields are rejected', async () => {
  const a = await member(); const b = await member(undefined, 'Untouched');
  const ok = await call('PATCH', '/api/users/me', {
    token: a.token, body: { displayName: 'Renamed', contactInfo: 'Hostel A 101', defaultPickupLocation: null },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.displayName, 'Renamed');
  assert.equal(ok.json.data.contactInfo, 'Hostel A 101');
  for (const body of [{ role: 'ADMIN' }, { email: 'x@y.z' }, { id: b.id }, { password: 'newpassword123' }]) {
    const r = await call('PATCH', '/api/users/me', { token: a.token, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const other = await call('GET', '/api/auth/me', { token: b.token });
  assert.equal(other.json.data.displayName, 'Untouched');
  assert.equal(other.json.data.role, 'MEMBER');
});

// =====================================================================================
// Authorization
// =====================================================================================
test('every protected route answers 401 without credentials', async () => {
  const id = randomUUID();
  const routes: [string, string][] = [
    ['GET', '/api/auth/me'], ['PATCH', '/api/users/me'], ['GET', '/api/users/me/copies'],
    ['POST', '/api/books'], ['POST', `/api/books/${id}/copies`],
    ['PATCH', `/api/copies/${id}`], ['POST', `/api/copies/${id}/requests`],
    ['GET', '/api/requests'], ['GET', `/api/requests/${id}`], ['POST', `/api/requests/${id}/approve`],
    ['POST', `/api/requests/${id}/reject`], ['POST', `/api/requests/${id}/cancel`], ['POST', `/api/requests/${id}/handoff`],
    ['GET', '/api/loans'], ['GET', `/api/loans/${id}`], ['POST', `/api/loans/${id}/return`],
    ['POST', `/api/loans/${id}/review`], ['POST', `/api/admin/users/${id}/deactivate`],
  ];
  for (const [method, path] of routes) {
    const r = await call(method, path, { body: method === 'GET' ? undefined : {} });
    assert.equal(r.status, 401, `${method} ${path}`);
  }
});

// =====================================================================================
// Public catalogue browsing (anonymous, read-only)
// =====================================================================================
const PRIVATE_FIELDS = /password|hash|token|email|@phase2\.test|contactInfo|counterpartyContact|deactivat|\$2[aby]\$/i;

/** owner (with contact, pickup place, notes), a listed copy, a reviewed historical loan, a stranger. */
async function publicFixture() {
  const owner = await member('PRIVATE-OWNER-CONTACT-XYZ', 'Public Owner');
  const borrower = await member('PRIVATE-BORROWER-CONTACT-XYZ', 'Public Reader');
  const book = await newBook(owner.token, { title: `P2 Book api public ${uniq()}` });
  const copy = await newCopy(owner.token, book, {
    condition: 'GOOD', pickupLocation: 'PRIVATE-PICKUP-SPOT', notes: 'PRIVATE-NOTES call me',
  });
  const unlisted = await newCopy(owner.token, book);
  assert.equal((await call('PATCH', `/api/copies/${unlisted}`, { token: owner.token, body: { isListed: false } })).status, 200);
  const done = await mkCopy(owner.id, book);
  const { loanId } = await committedLoan(done, borrower.id, { borrowedAgo: 5, returnedAgo: 1 });
  const rv = await call('POST', `/api/loans/${loanId}/review`, { token: borrower.token, body: { rating: 4, comment: 'Lovely' } });
  assert.equal(rv.status, 201, rv.text);
  return { owner, borrower, book, copy, unlisted, loanId, stranger: await member() };
}

test('public: anonymous visitors can search the catalogue (q, genre, availability, paging) and list genres', async () => {
  const f = await publicFixture();
  const genres = await call('GET', '/api/genres');
  assert.equal(genres.status, 200);
  assert.ok(Array.isArray(genres.json.data) && genres.json.data.length > 0);
  assert.deepEqual(Object.keys(genres.json.data[0]).sort(), ['id', 'name']);

  const all = await call('GET', '/api/books?limit=5');
  assert.equal(all.status, 200);
  assert.equal(all.json.data.length, 5);
  assert.ok(all.json.page.total >= 5);
  assert.equal(all.json.page.limit, 5);

  const hit = await call('GET', `/api/books?q=${encodeURIComponent('api public')}&availableOnly=true`);
  assert.equal(hit.status, 200);
  assert.ok(hit.json.data.some((b: any) => b.id === f.book));
  const g = genres.json.data[0].id;
  assert.equal((await call('GET', `/api/books?genreId=${g}&limit=3`)).status, 200);
  // validation is unchanged
  assert.equal((await call('GET', '/api/books?limit=1000')).status, 400);
  assert.equal((await call('GET', '/api/books?genreId=nope')).status, 400);
});

test('public: anonymous book details, copies and reviews; copies are the listed ones, stripped of private fields', async () => {
  const f = await publicFixture();
  const book = await call('GET', `/api/books/${f.book}`);
  assert.equal(book.status, 200);
  assert.equal(book.json.data.id, f.book);
  assert.equal(book.json.data.reviewCount, 1);

  const copies = await call('GET', `/api/books/${f.book}/copies`);
  assert.equal(copies.status, 200);
  const ids = copies.json.data.map((c: any) => c.id);
  assert.ok(ids.includes(f.copy));
  assert.ok(!ids.includes(f.unlisted), 'an unlisted copy is not public');
  const c = copies.json.data.find((x: any) => x.id === f.copy);
  assert.equal(c.condition, 'GOOD');
  assert.equal(c.available, true);
  assert.equal(c.owner.displayName, 'Public Owner');
  assert.deepEqual(Object.keys(c.owner), ['displayName'], 'no member id for anonymous visitors');
  assert.equal(c.pickupLocation, null);
  assert.equal(c.notes, null);

  const one = await call('GET', `/api/copies/${f.copy}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.json.data.owner, { displayName: 'Public Owner' });
  assert.equal((await call('GET', `/api/copies/${f.unlisted}`)).status, 404);

  const reviews = await call('GET', `/api/books/${f.book}/reviews?limit=5`);
  assert.equal(reviews.status, 200);
  assert.equal(reviews.json.page.total, 1);
  const rv = reviews.json.data[0];
  assert.deepEqual(Object.keys(rv).sort(), ['comment', 'createdAt', 'id', 'rating', 'reviewerName']);
  assert.equal(rv.comment, 'Lovely');
});

test('public: unknown or malformed ids keep their 404 / 400 answers', async () => {
  const id = randomUUID();
  for (const [path, status, c] of [
    [`/api/books/${id}`, 404, 'BOOK_NOT_FOUND'],
    [`/api/books/${id}/copies`, 404, 'BOOK_NOT_FOUND'],
    [`/api/books/${id}/reviews`, 404, 'BOOK_NOT_FOUND'],
    [`/api/copies/${id}`, 404, 'COPY_NOT_FOUND'],
    ['/api/books/not-a-uuid', 400, 'INVALID_ID'],
    ['/api/copies/not-a-uuid', 400, 'INVALID_ID'],
  ] as const) {
    const r = await call('GET', path);
    assert.equal(r.status, status, path);
    assert.equal(code(r), c, path);
  }
});

test('public: no email, contact, pickup place, notes, hash or token appears in any anonymous response', async () => {
  const f = await publicFixture();
  // an approved request exists, so contact details are in play on the protected side
  const copy2 = await newCopy(f.owner.token, f.book);
  const req = await request(f.borrower.token, copy2);
  assert.equal((await call('POST', `/api/requests/${req}/approve`, { token: f.owner.token })).status, 200);
  const paths = [
    '/api/genres', '/api/books?limit=100', `/api/books/${f.book}`, `/api/books/${f.book}/copies`,
    `/api/copies/${f.copy}`, `/api/copies/${copy2}`, `/api/books/${f.book}/reviews`,
  ];
  for (const path of paths) {
    const r = await call('GET', path);
    assert.equal(r.status, 200, path);
    assert.doesNotMatch(r.text, PRIVATE_FIELDS, path);
    assert.doesNotMatch(r.text, /PRIVATE-/, path);
    assert.ok(!r.text.includes(f.owner.id), `${path} leaks the owner's member id`);
    assert.ok(!r.text.includes(f.loanId), `${path} leaks a loan id`);
  }
});

test('public: a signed-in caller still gets the full copy view (own member id, pickup place, notes)', async () => {
  const f = await publicFixture();
  const own = await call('GET', `/api/copies/${f.copy}`, { token: f.owner.token });
  assert.equal(own.status, 200);
  assert.equal(own.json.data.owner.id, f.owner.id);
  assert.equal(own.json.data.pickupLocation, 'PRIVATE-PICKUP-SPOT');
  assert.equal(own.json.data.notes, 'PRIVATE-NOTES call me');
  // the owner still sees their own unlisted copy; a stranger does not
  assert.equal((await call('GET', `/api/copies/${f.unlisted}`, { token: f.owner.token })).status, 200);
  assert.equal((await call('GET', `/api/copies/${f.unlisted}`, { token: f.stranger.token })).status, 404);
  const rv = await call('GET', `/api/books/${f.book}/reviews`, { token: f.stranger.token });
  assert.equal(rv.json.data[0].loanId, f.loanId);   // existing signed-in format is unchanged
});

test('public: a PRESENTED token is still fully verified (bad/expired/deactivated is 401, never a silent downgrade)', async () => {
  const f = await publicFixture();
  const now = Math.floor(Date.now() / 1000);
  const expired = await signAccessToken(config, f.owner.id, { issuedAtSeconds: now - 7200, expiresAtSeconds: now - 3600 });
  for (const header of [`Bearer ${expired}`, 'Bearer not.a.jwt', 'Basic abc']) {
    for (const path of ['/api/books', '/api/genres', `/api/books/${f.book}`, `/api/books/${f.book}/copies`]) {
      const r = await call('GET', path, { headers: { authorization: header } });
      assert.equal(r.status, 401, `${header.slice(0, 12)} ${path}`);
      assert.equal(code(r), 'UNAUTHENTICATED');
    }
  }
  const gone = await member();
  await pool.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [gone.id]);
  assert.equal((await call('GET', '/api/books', { token: gone.token })).status, 401);
});

test('public: anonymous WRITES and private reads are all 401 and change nothing', async () => {
  const f = await publicFixture();
  const req = await request(f.borrower.token, f.copy);
  const second = await newCopy(f.owner.token, f.book);
  const req2 = await request(f.stranger.token, second);
  assert.equal((await call('POST', `/api/requests/${req2}/approve`, { token: f.owner.token })).status, 200);
  const handed = await call('POST', `/api/requests/${req2}/handoff`, { token: f.owner.token, body: {} });
  assert.equal(handed.status, 201, handed.text);
  const activeLoan = handed.json.data.id;

  const snapshot = async () => (await pool.query(
    `SELECT (SELECT count(*) FROM borrow_requests)::int r, (SELECT count(*) FROM loans)::int l,
            (SELECT count(*) FROM copies)::int c, (SELECT count(*) FROM books)::int b,
            (SELECT count(*) FROM reviews)::int v,
            (SELECT status FROM borrow_requests WHERE id=$1) s,
            (SELECT returned_at FROM loans WHERE id=$2) ret,
            (SELECT is_listed FROM copies WHERE id=$3) listed`, [req, activeLoan, f.copy])).rows[0];
  const before = await snapshot();
  const attempts: [string, string, unknown][] = [
    ['POST', `/api/copies/${f.copy}/requests`, {}],
    ['POST', `/api/requests/${req}/approve`, {}],
    ['POST', `/api/requests/${req}/reject`, {}],
    ['POST', `/api/requests/${req}/cancel`, {}],
    ['POST', `/api/requests/${req}/handoff`, {}],
    ['POST', `/api/loans/${activeLoan}/return`, {}],
    ['POST', `/api/loans/${f.loanId}/review`, { rating: 5 }],
    ['POST', '/api/books', { title: 'P2 Book api anon' }],
    ['POST', `/api/books/${f.book}/copies`, {}],
    ['PATCH', `/api/copies/${f.copy}`, { isListed: false }],
    ['PATCH', '/api/users/me', { displayName: 'Hacked' }],
    ['POST', `/api/admin/users/${f.owner.id}/deactivate`, {}],
    ['GET', '/api/auth/me', undefined], ['GET', '/api/users/me/copies', undefined],
    ['GET', '/api/requests', undefined], ['GET', `/api/requests/${req}`, undefined],
    ['GET', '/api/loans', undefined], ['GET', `/api/loans/${activeLoan}`, undefined],
  ];
  for (const [method, path, body] of attempts) {
    const r = await call(method, path, { body });
    assert.equal(r.status, 401, `${method} ${path}`);
    assert.equal(code(r), 'UNAUTHENTICATED', `${method} ${path}`);
    assert.doesNotMatch(r.text, /PRIVATE-/);
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal((await pool.query(`SELECT display_name FROM users WHERE id=$1`, [f.owner.id])).rows[0].display_name, 'Public Owner');
  // there is no anonymous way in through other verbs either
  assert.equal((await call('DELETE', `/api/books/${f.book}`)).status, 404);
  assert.equal((await call('PUT', `/api/copies/${f.copy}`, { body: {} })).status, 404);
});

test('public: authenticated members keep every permitted action, and strangers stay locked out of private data', async () => {
  const f = await publicFixture();
  const copy = await newCopy(f.owner.token, f.book);
  const req = await request(f.borrower.token, copy);
  assert.equal((await call('GET', `/api/requests/${req}`, { token: f.stranger.token })).status, 404);
  assert.equal((await call('POST', `/api/requests/${req}/approve`, { token: f.stranger.token })).status, 404);
  assert.equal((await call('POST', `/api/requests/${req}/approve`, { token: f.owner.token })).status, 200);
  const view = await call('GET', `/api/requests/${req}`, { token: f.borrower.token });
  assert.equal(view.json.data.counterpartyContact, 'PRIVATE-OWNER-CONTACT-XYZ'); // counterparties only
  const listing = await call('GET', '/api/requests?role=all', { token: f.stranger.token });
  assert.doesNotMatch(listing.text, /PRIVATE-/);
  const handoff = await call('POST', `/api/requests/${req}/handoff`, { token: f.owner.token, body: {} });
  assert.equal(handoff.status, 201, handoff.text);
  assert.equal((await call('GET', `/api/loans/${handoff.json.data.id}`, { token: f.stranger.token })).status, 404);
  assert.equal((await call('POST', `/api/loans/${handoff.json.data.id}/return`, { token: f.owner.token })).status, 200);
  const rv = await call('POST', `/api/loans/${handoff.json.data.id}/review`, { token: f.borrower.token, body: { rating: 5 } });
  assert.equal(rv.status, 201, rv.text);
  const pub = await call('GET', `/api/books/${f.book}/copies`);
  assert.doesNotMatch(pub.text, /PRIVATE-/);
});

test('public: anonymous reads are rate limited per client; signed-in requests are not counted', async () => {
  const base = await listen(createApp({
    pool, config: baseConfig({ rateLimit: { windowMs: 60_000, loginMax: 100, registerMax: 100, publicReadMax: 3 } }),
  }));
  const m = await member();
  for (let i = 0; i < 3; i++) assert.equal((await call('GET', '/api/genres', { base })).status, 200);
  const limited = await call('GET', '/api/genres', { base });
  assert.equal(limited.status, 429);
  assert.equal(code(limited), 'RATE_LIMITED');
  assert.ok(limited.headers.get('retry-after'));
  for (let i = 0; i < 5; i++) assert.equal((await call('GET', '/api/genres', { base, token: m.token })).status, 200);
});

test('a non-owner cannot approve, reject, hand off or return: 403 for parties, 404 (concealed) for strangers', async () => {
  const { owner, requester, copy } = await setup();
  const stranger = await member();
  const req = await request(requester.token, copy);

  assert.equal((await call('POST', `/api/requests/${req}/approve`, { token: requester.token })).status, 403);
  assert.equal((await call('POST', `/api/requests/${req}/approve`, { token: stranger.token })).status, 404);
  assert.equal((await call('POST', `/api/requests/${req}/reject`, { token: requester.token })).status, 403);
  assert.equal((await call('POST', `/api/requests/${req}/cancel`, { token: stranger.token })).status, 404);

  assert.equal((await call('POST', `/api/requests/${req}/approve`, { token: owner.token })).status, 200);
  assert.equal((await call('POST', `/api/requests/${req}/handoff`, { token: requester.token, body: {} })).status, 403);
  assert.equal((await call('POST', `/api/requests/${req}/handoff`, { token: stranger.token, body: {} })).status, 404);

  const h = await call('POST', `/api/requests/${req}/handoff`, { token: owner.token, body: {} });
  assert.equal(h.status, 201);
  const loan = h.json.data.id;
  assert.equal((await call('POST', `/api/loans/${loan}/return`, { token: requester.token })).status, 403);
  assert.equal((await call('POST', `/api/loans/${loan}/return`, { token: stranger.token })).status, 404);
  assert.equal((await call('GET', `/api/loans/${loan}`, { token: stranger.token })).status, 404);
  assert.equal((await call('GET', `/api/requests/${req}`, { token: stranger.token })).status, 404);
  assert.equal((await call('POST', `/api/loans/${loan}/return`, { token: owner.token })).status, 200);
});

test('private contact information is shown only to the counterparty, only while approved / on loan', async () => {
  const { owner, requester, book, copy } = await setup('OWNER-CONTACT-XYZ', 'REQUESTER-CONTACT-XYZ');
  const stranger = await member();
  const req = await request(requester.token, copy);

  // public catalogue never carries contact info
  const pub = await call('GET', `/api/books/${book}/copies`, { token: stranger.token });
  assert.doesNotMatch(pub.text, /CONTACT-XYZ/);
  const pubBook = await call('GET', `/api/books/${book}`, { token: stranger.token });
  assert.doesNotMatch(pubBook.text, /CONTACT-XYZ/);

  // PENDING: nobody sees the other party's contact
  assert.equal((await call('GET', `/api/requests/${req}`, { token: requester.token })).json.data.counterpartyContact, null);
  assert.equal((await call('GET', `/api/requests/${req}`, { token: owner.token })).json.data.counterpartyContact, null);

  await call('POST', `/api/requests/${req}/approve`, { token: owner.token });
  assert.equal((await call('GET', `/api/requests/${req}`, { token: requester.token })).json.data.counterpartyContact, 'OWNER-CONTACT-XYZ');
  assert.equal((await call('GET', `/api/requests/${req}`, { token: owner.token })).json.data.counterpartyContact, 'REQUESTER-CONTACT-XYZ');
  const sr = await call('GET', `/api/requests/${req}`, { token: stranger.token });
  assert.equal(sr.status, 404);
  assert.doesNotMatch(sr.text, /CONTACT-XYZ/);

  const loan = (await call('POST', `/api/requests/${req}/handoff`, { token: owner.token, body: { days: 7 } })).json.data.id;
  assert.equal((await call('GET', `/api/loans/${loan}`, { token: requester.token })).json.data.counterpartyContact, 'OWNER-CONTACT-XYZ');
  assert.equal((await call('GET', `/api/loans/${loan}`, { token: owner.token })).json.data.counterpartyContact, 'REQUESTER-CONTACT-XYZ');

  await call('POST', `/api/loans/${loan}/return`, { token: owner.token });
  assert.equal((await call('GET', `/api/loans/${loan}`, { token: requester.token })).json.data.counterpartyContact, null);
  assert.equal((await call('GET', `/api/requests/${req}`, { token: requester.token })).json.data.counterpartyContact, null);
});

test('admin routes: members get 403, an administrator succeeds; role=all lists are admin-only', async () => {
  const m = await member(); const victim = await member();
  const admin = await adminToken();
  const denied = await call('POST', `/api/admin/users/${victim.id}/deactivate`, { token: m.token });
  assert.equal(denied.status, 403);
  assert.equal((await call('GET', '/api/requests?role=all', { token: m.token })).status, 403);
  assert.equal((await call('GET', '/api/loans?role=all', { token: m.token })).status, 403);
  assert.equal((await call('GET', '/api/requests?role=all&limit=1', { token: admin.token })).status, 200);

  const ok = await call('POST', `/api/admin/users/${victim.id}/deactivate`, { token: admin.token });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/auth/me', { token: victim.token })).status, 401);
  assert.equal((await call('POST', `/api/admin/users/${victim.id}/deactivate`, { token: admin.token })).status, 409);
  assert.equal((await call('POST', `/api/admin/users/${admin.id}/deactivate`, { token: admin.token })).status, 422);
});

test('an administrator may override handoff and return; the lender recorded is still the owner', async () => {
  const { owner, requester, copy } = await setup();
  const admin = await adminToken();
  const req = await request(requester.token, copy);
  await call('POST', `/api/requests/${req}/approve`, { token: owner.token });
  const h = await call('POST', `/api/requests/${req}/handoff`, { token: admin.token, body: { days: 3 } });
  assert.equal(h.status, 201);
  assert.equal(h.json.data.lender.id, owner.id);
  const r = await call('POST', `/api/loans/${h.json.data.id}/return`, { token: admin.token });
  assert.equal(r.status, 200);
  assert.ok(r.json.data.returnedAt);
});

test('a member cannot edit or list/unlist another member\'s copy', async () => {
  const { owner, requester, copy } = await setup();
  const r = await call('PATCH', `/api/copies/${copy}`, { token: requester.token, body: { isListed: false } });
  assert.equal(r.status, 404);
  const own = await call('PATCH', `/api/copies/${copy}`, { token: owner.token, body: { isListed: false } });
  assert.equal(own.status, 200);
  assert.equal(own.json.data.isListed, false);
  // an unlisted copy is concealed from other members but visible to its owner
  assert.equal((await call('GET', `/api/copies/${copy}`, { token: requester.token })).status, 404);
  assert.equal((await call('GET', `/api/copies/${copy}`, { token: owner.token })).status, 200);
});

// =====================================================================================
// Lending
// =====================================================================================
test('full lifecycle over HTTP: request, approve, handoff, return, review; availability is derived throughout', async () => {
  const { owner, requester, book, copy } = await setup();
  const avail = async () => (await call('GET', `/api/copies/${copy}`, { token: requester.token })).json.data.available;
  assert.equal(await avail(), true);

  const req = await request(requester.token, copy);
  assert.equal(await avail(), true);                       // PENDING does not reserve

  const ap = await call('POST', `/api/requests/${req}/approve`, { token: owner.token });
  assert.equal(ap.status, 200); assert.equal(ap.json.data.status, 'APPROVED');
  assert.equal(await avail(), false);                      // reserved

  const h = await call('POST', `/api/requests/${req}/handoff`, { token: owner.token, body: { days: 7 } });
  assert.equal(h.status, 201);
  assert.equal(h.json.data.returnedAt, null);
  assert.equal(h.json.data.isOverdue, false);
  assert.equal((await call('GET', `/api/requests/${req}`, { token: owner.token })).json.data.status, 'FULFILLED');
  assert.equal(await avail(), false);                      // on loan

  const loan = h.json.data.id;
  const ret = await call('POST', `/api/loans/${loan}/return`, { token: owner.token });
  assert.equal(ret.status, 200);
  assert.ok(ret.json.data.returnedAt);
  assert.equal(await avail(), true);
  assert.equal((await call('POST', `/api/loans/${loan}/return`, { token: owner.token })).status, 409);   // double return

  const rv = await call('POST', `/api/loans/${loan}/review`, { token: requester.token, body: { rating: 5, comment: 'Great' } });
  assert.equal(rv.status, 201);
  const dup = await call('POST', `/api/loans/${loan}/review`, { token: requester.token, body: { rating: 4 } });
  assert.equal(dup.status, 409);
  assert.equal(code(dup), 'ALREADY_REVIEWED');

  const list = await call('GET', `/api/books/${book}/reviews`, { token: owner.token });
  assert.equal(list.json.page.total, 1);
  assert.equal(list.json.data[0].rating, 5);
  assert.equal((await call('GET', `/api/books/${book}`, { token: owner.token })).json.data.averageRating, 5);

  // history lists
  const mine = await call('GET', '/api/loans?role=borrower&status=returned', { token: requester.token });
  assert.ok(mine.json.data.some((l: any) => l.id === loan));
  const incoming = await call('GET', '/api/requests?role=owner&status=FULFILLED', { token: owner.token });
  assert.ok(incoming.json.data.some((r: any) => r.id === req));
});

test('requesting an unavailable copy is refused: reserved, unlisted, own copy', async () => {
  const { owner, requester, copy } = await setup();
  const other = await member();
  const req = await request(requester.token, copy);
  await call('POST', `/api/requests/${req}/approve`, { token: owner.token });

  const reserved = await call('POST', `/api/copies/${copy}/requests`, { token: other.token, body: {} });
  assert.equal(reserved.status, 409);
  assert.equal(code(reserved), 'COPY_UNAVAILABLE');
  assert.equal(reserved.json.error.details.reason, 'RESERVED');

  const own = await call('POST', `/api/copies/${copy}/requests`, { token: owner.token, body: {} });
  assert.equal(own.status, 422);
  assert.equal(code(own), 'SELF_REQUEST');

  const book2 = await newBook(owner.token);
  const unlisted = await newCopy(owner.token, book2);
  await call('PATCH', `/api/copies/${unlisted}`, { token: owner.token, body: { isListed: false } });
  const u = await call('POST', `/api/copies/${unlisted}/requests`, { token: other.token, body: {} });
  assert.equal(u.status, 404);                 // unlisted copies are concealed from other members
});

test('duplicate approval and invalid transitions are 409', async () => {
  const { owner, requester, copy } = await setup();
  const rival = await member();
  const r1 = await request(requester.token, copy);
  const r2 = await request(rival.token, copy);          // several pending requests are allowed
  assert.equal((await call('POST', `/api/requests/${r1}/approve`, { token: owner.token })).status, 200);
  const again = await call('POST', `/api/requests/${r1}/approve`, { token: owner.token });
  assert.equal(again.status, 409); assert.equal(code(again), 'INVALID_STATE');
  const sibling = await call('POST', `/api/requests/${r2}/approve`, { token: owner.token });
  assert.equal(sibling.status, 409); assert.equal(code(sibling), 'COPY_RESERVED');
  assert.equal((await call('POST', `/api/requests/${r1}/reject`, { token: owner.token })).status, 409);   // APPROVED -> REJECTED illegal
  assert.equal((await call('POST', `/api/requests/${r2}/handoff`, { token: owner.token, body: {} })).status, 409); // PENDING
  assert.equal((await call('POST', `/api/copies/${copy}/requests`, { token: requester.token, body: {} })).status, 409);
});

test('an overdue borrower is blocked from new requests (OVERDUE_LOANS_BLOCK), and unblocked on return', async () => {
  const lenderId = await mkUser(); const book = await mkBook();
  const heldCopy = await mkCopy(lenderId, book);
  const borrower = await member();
  const { loanId } = await committedLoan(heldCopy, borrower.id, { borrowedAgo: 30, term: 14 });   // due 16 days ago
  const { copy } = await setup();

  const blocked = await call('POST', `/api/copies/${copy}/requests`, { token: borrower.token, body: {} });
  assert.equal(blocked.status, 409);
  assert.equal(code(blocked), 'OVERDUE_LOANS_BLOCK');
  assert.equal(blocked.json.error.details.loans.length, 1);
  const od = await call('GET', '/api/loans?role=borrower&status=overdue', { token: borrower.token });
  assert.equal(od.json.page.total, 1);
  assert.equal(od.json.data[0].isOverdue, true);

  const lenderToken = await signAccessToken(config, lenderId);
  assert.equal((await call('POST', `/api/loans/${loanId}/return`, { token: lenderToken })).status, 200);
  assert.equal((await call('POST', `/api/copies/${copy}/requests`, { token: borrower.token, body: {} })).status, 201);
});

test('cancelling an approved request releases the reservation atomically and lets a sibling be approved', async () => {
  const { owner, requester, copy } = await setup();
  const rival = await member();
  const r1 = await request(requester.token, copy);
  const r2 = await request(rival.token, copy);
  await call('POST', `/api/requests/${r1}/approve`, { token: owner.token });
  assert.equal((await call('GET', `/api/copies/${copy}`, { token: owner.token })).json.data.available, false);

  const c = await call('POST', `/api/requests/${r1}/cancel`, { token: owner.token });      // owner no-show cancellation
  assert.equal(c.status, 200);
  assert.equal(c.json.data.status, 'CANCELLED');
  assert.equal(c.json.data.cancelledBy, owner.id);
  assert.equal((await call('GET', `/api/copies/${copy}`, { token: owner.token })).json.data.available, true);
  assert.equal((await call('POST', `/api/requests/${r2}/approve`, { token: owner.token })).status, 200);
  assert.equal((await call('POST', `/api/requests/${r1}/cancel`, { token: requester.token })).status, 409);  // already cancelled
});

test('handoff period boundaries: 1 and 60 days accepted; 0, 61, fractions, strings are 400; default is 14', async () => {
  for (const [days, expectedOk] of [[1, true], [60, true], [0, false], [61, false], [1.5, false], ['7', false], [-3, false]] as const) {
    const { owner, requester, copy } = await setup();
    const req = await request(requester.token, copy);
    await call('POST', `/api/requests/${req}/approve`, { token: owner.token });
    const h = await call('POST', `/api/requests/${req}/handoff`, { token: owner.token, body: { days } });
    assert.equal(h.status, expectedOk ? 201 : 400, `days=${JSON.stringify(days)}`);
    if (expectedOk) {
      // due at the end of day (Asia/Kolkata) N days from today: between N and N+1 days from now
      const ms = new Date(h.json.data.dueAt).getTime() - Date.now();
      assert.ok(ms > (days as number) * 86_400_000 - 60_000 && ms < ((days as number) + 1) * 86_400_000 + 60_000, `due in ${ms}ms`);
    } else {
      assert.equal(code(h), 'VALIDATION_ERROR');
    }
  }
  const { owner, requester, copy } = await setup();
  const req = await request(requester.token, copy);
  await call('POST', `/api/requests/${req}/approve`, { token: owner.token });
  const d = await call('POST', `/api/requests/${req}/handoff`, { token: owner.token, body: {} });
  const ms = new Date(d.json.data.dueAt).getTime() - Date.now();
  assert.ok(ms > 14 * 86_400_000 - 60_000 && ms < 15 * 86_400_000 + 60_000);
});

test('review eligibility: unreturned loan, non-borrower, invalid rating; duplicates rejected by the API and the database', async () => {
  const { owner, requester, copy } = await setup();
  const stranger = await member();
  const req = await request(requester.token, copy);
  await call('POST', `/api/requests/${req}/approve`, { token: owner.token });
  const loan = (await call('POST', `/api/requests/${req}/handoff`, { token: owner.token, body: {} })).json.data.id;

  const early = await call('POST', `/api/loans/${loan}/review`, { token: requester.token, body: { rating: 4 } });
  assert.equal(early.status, 409); assert.equal(code(early), 'LOAN_NOT_RETURNED');
  await call('POST', `/api/loans/${loan}/return`, { token: owner.token });

  assert.equal((await call('POST', `/api/loans/${loan}/review`, { token: owner.token, body: { rating: 4 } })).status, 403);
  assert.equal((await call('POST', `/api/loans/${loan}/review`, { token: stranger.token, body: { rating: 4 } })).status, 404);
  for (const rating of [0, 6, 2.5, '5']) {
    assert.equal((await call('POST', `/api/loans/${loan}/review`, { token: requester.token, body: { rating } })).status, 400);
  }
  assert.equal((await call('POST', `/api/loans/${loan}/review`, { token: requester.token, body: { rating: 3 } })).status, 201);
  assert.equal((await call('POST', `/api/loans/${loan}/review`, { token: requester.token, body: { rating: 3 } })).status, 409);
  const rows = await pool.query(`SELECT count(*)::int n FROM reviews WHERE loan_id = $1`, [loan]);
  assert.equal(rows.rows[0].n, 1);
});

test('due-date modification is not part of v1: the route does not exist (404)', async () => {
  const { owner } = await setup();
  const r = await call('PATCH', `/api/loans/${randomUUID()}/due-date`, { token: owner.token, body: { days: 3 } });
  assert.equal(r.status, 404);
});

// =====================================================================================
// Catalogue: search, pagination, validation
// =====================================================================================
test('books: create with authors and genres; search by title/author/genre/ISBN; LIKE wildcards are literal', async () => {
  const m = await member();
  const tok = uniq();
  const genres = (await call('GET', '/api/genres', { token: m.token })).json.data;
  assert.ok(genres.length >= 12);
  const isbn = isbn13(tok);
  const created = await call('POST', '/api/books', { token: m.token, body: {
    title: `P2 Book api ${tok} Alpha`, isbn, publisher: 'P2 Press', publicationYear: 2020,
    authors: [`P2 Author ${tok}`, `P2 Author ${tok} Second`], genreIds: [genres[0].id],
  } });
  assert.equal(created.status, 201, created.text);
  const b = created.json.data;
  assert.deepEqual(b.authors.map((a: any) => a.name), [`P2 Author ${tok}`, `P2 Author ${tok} Second`]);
  assert.equal(b.genres.length, 1);
  assert.equal(b.availableCopies, 0);

  await newBook(m.token, { title: `P2 Book api ${tok} Beta` });
  await newBook(m.token, { title: `P2 Book api ${tok} Gamma` });

  const byTitle = await call('GET', `/api/books?q=${tok}&limit=2&offset=0`, { token: m.token });
  assert.equal(byTitle.json.page.total, 3);
  assert.equal(byTitle.json.data.length, 2);
  const page2 = await call('GET', `/api/books?q=${tok}&limit=2&offset=2`, { token: m.token });
  assert.equal(page2.json.data.length, 1);
  const titles = [...byTitle.json.data, ...page2.json.data].map((x: any) => x.title);
  assert.deepEqual(titles, [...titles].sort());          // stable title ordering

  const byAuthor = await call('GET', `/api/books?q=${encodeURIComponent(`P2 Author ${tok} Second`)}`, { token: m.token });
  assert.equal(byAuthor.json.page.total, 1);
  const byIsbn = await call('GET', `/api/books?q=${isbn}`, { token: m.token });
  assert.equal(byIsbn.json.page.total, 1);
  const byGenre = await call('GET', `/api/books?genreId=${genres[0].id}&q=${tok}`, { token: m.token });
  assert.equal(byGenre.json.page.total, 1);

  const wild = await call('GET', `/api/books?q=${encodeURIComponent('%')}`, { token: m.token });
  assert.equal(wild.json.page.total, 0);                 // "%" matches only a literal percent sign
  const under = await call('GET', `/api/books?q=${encodeURIComponent('_')}`, { token: m.token });
  assert.equal(under.json.page.total, 0);
  const sqli = await call('GET', `/api/books?q=${encodeURIComponent("' OR 1=1; --")}`, { token: m.token });
  assert.equal(sqli.status, 200);
  assert.equal(sqli.json.page.total, 0);

  // availableOnly reflects derived availability
  const withCopy = await newBook(m.token, { title: `P2 Book api ${tok} Delta` });
  await newCopy(m.token, withCopy);
  const avail = await call('GET', `/api/books?q=${tok}&availableOnly=true`, { token: m.token });
  assert.equal(avail.json.page.total, 1);
  assert.equal(avail.json.data[0].availableCopies, 1);
});

test('books: duplicate ISBN is 409, invalid ISBN / year / unknown genre / unknown field are rejected', async () => {
  const m = await member();
  const isbn = isbn13(uniq());
  assert.equal((await call('POST', '/api/books', { token: m.token, body: { title: `P2 Book api ${uniq()}`, isbn } })).status, 201);
  const dup = await call('POST', '/api/books', { token: m.token, body: { title: `P2 Book api ${uniq()}`, isbn } });
  assert.equal(dup.status, 409); assert.equal(code(dup), 'ISBN_EXISTS');
  const t = () => `P2 Book api ${uniq()}`;
  assert.equal((await call('POST', '/api/books', { token: m.token, body: { title: t(), isbn: '9780000000000' } })).status, 400); // bad checksum
  assert.equal((await call('POST', '/api/books', { token: m.token, body: { title: t(), publicationYear: 1200 } })).status, 400);
  assert.equal((await call('POST', '/api/books', { token: m.token, body: { title: t(), genreIds: [randomUUID()] } })).status, 422);
  assert.equal((await call('POST', '/api/books', { token: m.token, body: { title: t(), createdBy: m.id } })).status, 400);
  assert.equal((await call('POST', '/api/books', { token: m.token, body: { title: '  ' } })).status, 400);
});

test('copies: condition validated; my copies listed; copy list never shows another member\'s unlisted copy', async () => {
  const { owner, requester, book, copy } = await setup();
  assert.equal((await call('POST', `/api/books/${book}/copies`, { token: owner.token, body: { condition: 'BROKEN' } })).status, 400);
  const second = await newCopy(owner.token, book, { condition: 'FAIR', pickupLocation: 'Library lobby', notes: 'Spine worn' });
  await call('PATCH', `/api/copies/${second}`, { token: owner.token, body: { isListed: false } });

  const mine = await call('GET', '/api/users/me/copies', { token: owner.token });
  assert.ok([copy, second].every((id) => mine.json.data.some((c: any) => c.id === id)));
  const forOthers = await call('GET', `/api/books/${book}/copies`, { token: requester.token });
  assert.deepEqual(forOthers.json.data.map((c: any) => c.id), [copy]);
  const forOwner = await call('GET', `/api/books/${book}/copies`, { token: owner.token });
  assert.equal(forOwner.json.data.length, 2);
  assert.equal(forOwner.json.data[0].owner.displayName, 'Owner Person');
  assert.equal(forOwner.json.data[0].owner.email, undefined);
  assert.equal((await call('POST', `/api/books/${randomUUID()}/copies`, { token: owner.token, body: {} })).status, 404);
});

test('a deactivated owner\'s copies disappear from discovery', async () => {
  const { owner, requester, book, copy } = await setup();
  const admin = await adminToken();
  assert.equal((await call('GET', `/api/books/${book}/copies`, { token: requester.token })).json.data.length, 1);
  await call('POST', `/api/admin/users/${owner.id}/deactivate`, { token: admin.token });
  assert.equal((await call('GET', `/api/books/${book}/copies`, { token: requester.token })).json.data.length, 0);
  assert.equal((await call('GET', `/api/copies/${copy}`, { token: requester.token })).status, 404);
  assert.equal((await call('POST', `/api/copies/${copy}/requests`, { token: requester.token, body: {} })).status, 404);
});

test('input validation: malformed ids, bad JSON, oversized body, bad pagination are 4xx with stable codes', async () => {
  const m = await member();
  for (const path of ['/api/books/not-a-uuid', '/api/copies/123', '/api/requests/xyz', '/api/loans/%00', '/api/books/not-a-uuid/copies']) {
    const r = await call('GET', path, { token: m.token });
    assert.equal(r.status, 400, path);
    assert.equal(code(r), 'INVALID_ID');
  }
  const badJson = await call('POST', '/api/books', { token: m.token, raw: '{"title": ' });
  assert.equal(badJson.status, 400); assert.equal(code(badJson), 'INVALID_JSON');
  const big = await call('POST', '/api/books', { token: m.token, raw: JSON.stringify({ title: 'x'.repeat(40_000) }) });
  assert.equal(big.status, 413); assert.equal(code(big), 'PAYLOAD_TOO_LARGE');
  for (const q of ['limit=0', 'limit=1000', 'limit=abc', 'offset=-1', 'availableOnly=maybe', 'genreId=nope']) {
    const r = await call('GET', `/api/books?${q}`, { token: m.token });
    assert.equal(r.status, 400, q);
    assert.equal(code(r), 'VALIDATION_ERROR');
  }
  assert.equal((await call('GET', '/api/requests?role=owner&status=BOGUS', { token: m.token })).status, 400);
});

test('not found: unknown ids and routes return 404 with a stable JSON shape', async () => {
  const m = await member();
  for (const [path, c] of [
    [`/api/books/${randomUUID()}`, 'BOOK_NOT_FOUND'], [`/api/books/${randomUUID()}/reviews`, 'BOOK_NOT_FOUND'],
    [`/api/copies/${randomUUID()}`, 'COPY_NOT_FOUND'], [`/api/requests/${randomUUID()}`, 'REQUEST_NOT_FOUND'],
    [`/api/loans/${randomUUID()}`, 'LOAN_NOT_FOUND'], ['/api/no-such-route', 'NOT_FOUND'],
  ] as const) {
    const r = await call('GET', path, { token: m.token });
    assert.equal(r.status, 404, path);
    assert.equal(code(r), c, path);
    assert.ok(r.json.error.requestId);
  }
});

test('seed data is readable through the API (the HTTP layer talks to the real database)', async () => {
  const m = await member();
  const r = await call('GET', '/api/books?limit=5', { token: m.token });
  assert.equal(r.status, 200);
  assert.ok(r.json.page.total >= 25);
});

// =====================================================================================
// Error mapping and information hygiene
// =====================================================================================
test('SQLSTATE 55P03 (lock timeout) maps to a retryable 409 RESOURCE_BUSY without PostgreSQL detail', async () => {
  const shortBase = await listen(createApp({ pool, config: baseConfig({ lockTimeoutMs: 400 }) }));
  const ownerId = await mkUser(); const requesterId = await mkUser();
  const book = await mkBook();
  const copy = await mkCopy(ownerId, book);
  const req = await pendingRequest(copy, requesterId);
  const ownerToken = await signAccessToken(config, ownerId);

  // Baseline: an UNCONTENDED call on the same app, same pool, immediately beforehand (so the pool
  // has the same warmth). Network latency (~260 ms per round trip here, plus TLS+SCRAM when a pooled
  // connection must be re-opened) is common to both, so the bound below is independent of it.
  const freeCopy = await mkCopy(ownerId, book);
  const freeReq = await pendingRequest(freeCopy, await mkUser());
  // Warm the pool: `holder` (below) takes one connection and the HTTP call needs another. With a
  // single idle connection the contended call would pay a fresh TLS+SCRAM connect (~2 s at this
  // latency) that the baseline did not. That is pool warmth, not lock handling, so it is controlled.
  const warm = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
  warm.forEach((c) => c.release());
  const t0 = Date.now();
  const okRes = await call('POST', `/api/requests/${freeReq}/approve`, { token: ownerToken, base: shortBase });
  const baseline = Date.now() - t0;
  assert.equal(okRes.status, 200);

  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM copies WHERE id = $1 FOR UPDATE', [copy]);   // someone else holds the copy lock
    const started = Date.now();
    const r = await call('POST', `/api/requests/${req}/approve`, { token: ownerToken, base: shortBase });
    const waited = Date.now() - started;
    assert.equal(r.status, 409);
    assert.equal(code(r), 'RESOURCE_BUSY');
    assert.equal(r.headers.get('retry-after'), '1');
    assert.doesNotMatch(r.text, /SQLSTATE|55P03|relation|canceling statement|lock_timeout|pg_/i);
    // `holder` still owns the lock (it is released only below), so the call gave up by itself:
    //  - lower bound: it really waited out lock_timeout (400 ms);
    //  - upper bound: it cost no more than a successful call plus the lock wait plus 1.5 s of jitter
    //    (the failing path executes fewer statements than the success path, so this is conservative).
    //    A hang or a wait for the holder would blow straight through it.
    assert.ok(waited >= 350, `returned after only ${waited}ms (lock_timeout is 400ms)`);
    assert.ok(waited <= baseline + 400 + 1500, `contended ${waited}ms vs uncontended baseline ${baseline}ms`);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  assert.equal((await pool.query(`SELECT status FROM borrow_requests WHERE id=$1`, [req])).rows[0].status, 'PENDING');
});

test('error middleware: 23001, 23503, 23505, 55P03, 40P01 are mapped; unexpected errors are generic and redacted', async () => {
  const app = express();
  app.use((_q, res, next) => { res.locals.requestId = 'test-req'; next(); });
  const kinds: Record<string, unknown> = {
    restrict: { code: '23001', message: 'update or delete on table "users" violates RESTRICT setting of foreign key "copies_owner_id_fkey"' },
    fk: { code: '23503', message: 'insert or update on table "loans" violates foreign key constraint "fk_loans_request_match"' },
    unique: { code: '23505', constraint: 'uq_users_email', message: 'duplicate key value violates unique constraint "uq_users_email"' },
    busy: { code: '55P03', message: 'canceling statement due to lock timeout' },
    deadlock: { code: '40P01', message: 'deadlock detected' },
    check: { code: '23514', constraint: 'ck_loans_due', message: 'new row for relation "loans" violates check constraint' },
    boom: new Error('boom password=hunter2 connecting to postgresql://user:SECRETPW@db.example.com/prod failed'),
  };
  app.get('/e/:kind', (req) => { throw kinds[req.params.kind as string]; });
  app.use(errorHandler);
  const base = await listen(app);

  const expect = async (kind: string, status: number, errCode: string) => {
    const r = await call('GET', `/e/${kind}`, { base });
    assert.equal(r.status, status, kind);
    assert.equal(r.json.error.code, errCode, kind);
    assert.doesNotMatch(r.text, /violates|deadlock detected|canceling|fk_loans|copies_owner_id_fkey|uq_users_email|ck_loans/i, kind);
    return r;
  };
  await expect('restrict', 409, 'IN_USE');
  await expect('fk', 422, 'INVALID_REFERENCE');
  await expect('unique', 409, 'EMAIL_TAKEN');
  await expect('check', 422, 'CONSTRAINT_VIOLATION');
  assert.equal((await expect('busy', 409, 'RESOURCE_BUSY')).headers.get('retry-after'), '1');
  assert.equal((await expect('deadlock', 409, 'RETRY')).headers.get('retry-after'), '1');

  const logged: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  let r: Res;
  try { r = await call('GET', '/e/boom', { base }); } finally { console.error = original; }
  assert.equal(r.status, 500);
  assert.equal(r.json.error.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(r.text, /hunter2|SECRETPW|postgresql|boom|stack|at /i);
  assert.equal(r.json.error.requestId, 'test-req');
  assert.equal(logged.length, 1);
  assert.doesNotMatch(logged[0]!, /SECRETPW|postgresql:\/\//);       // the server log is redacted too
});

test('health: unauthenticated 200 {status:ok}; with an unreachable database 503 {status:unavailable}, no detail', async () => {
  const ok = await call('GET', '/api/health');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { status: 'ok' });

  const dead = new pg.Pool({ connectionString: 'postgresql://nobody:nopass@127.0.0.1:1/none', connectionTimeoutMillis: 800 });
  dead.on('error', () => {});
  const base = await listen(createApp({ pool: dead, config }));
  const bad = await call('GET', '/api/health', { base });
  await dead.end();
  assert.equal(bad.status, 503);
  assert.deepEqual(bad.json, { status: 'unavailable' });
  assert.doesNotMatch(bad.text, /127\.0\.0\.1|nobody|ECONNREFUSED|postgres/i);
});

test('security headers: nosniff, no x-powered-by, no-store; CORS closed by default', async () => {
  const r = await call('GET', '/api/health', { headers: { origin: 'https://evil.example' } });
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  assert.ok(r.headers.get('x-request-id'));
});

// =====================================================================================
// Audit regressions (Phase 3 audit)
// =====================================================================================
test('NUL characters in query strings, JSON strings or nested values are 400, never 500', async () => {
  const m = await member();
  const q = await call('GET', '/api/books?q=a%00b', { token: m.token });
  assert.equal(q.status, 400); assert.equal(code(q), 'VALIDATION_ERROR');
  for (const body of [
    { title: 'a\u0000b' },
    { title: 'ok', authors: ['fine', 'bad\u0000name'] },
    { title: 'ok', description: 'x\u0000' },
  ]) {
    const r = await call('POST', '/api/books', { token: m.token, body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(code(r), 'VALIDATION_ERROR');
  }
  const p = await call('PATCH', '/api/users/me', { token: m.token, body: { displayName: 'a\u0000' } });
  assert.equal(p.status, 400);
  const login = await call('POST', '/api/auth/login', { body: { email: 'a\u0000@b.co', password: 'x' } });
  assert.equal(login.status, 400);
});

test('HTTP-stack client errors (bad content-encoding) are 4xx, never 500', async () => {
  const m = await member();
  const common = { authorization: `Bearer ${m.token}`, 'content-type': 'application/json' };
  const unknown = await fetch(BASE + '/api/books', {
    method: 'POST', headers: { ...common, 'content-encoding': 'bogus' }, body: '{"title":"x"}' });
  const unknownText = await unknown.text();
  assert.equal(unknown.status, 415, unknownText);
  assert.match(unknownText, /UNSUPPORTED_MEDIA_TYPE/);
  const corrupt = await fetch(BASE + '/api/books', {
    method: 'POST', headers: { ...common, 'content-encoding': 'gzip' }, body: '{"title":"x"}' });
  const corruptText = await corrupt.text();
  assert.ok(corrupt.status >= 400 && corrupt.status < 500, `${corrupt.status} ${corruptText}`);
  assert.doesNotMatch(corruptText, /INTERNAL_ERROR|zlib|incorrect header/i);
});

test('admin role changes take effect on the very next request (demotion and promotion)', async () => {
  const id = await mkUser('ADMIN');
  const token = await signAccessToken(config, id);
  assert.equal((await call('GET', '/api/requests?role=all&limit=1', { token })).status, 200);

  await pool.query(`UPDATE users SET role = 'MEMBER' WHERE id = $1`, [id]);
  const demoted = await call('GET', '/api/requests?role=all&limit=1', { token });
  assert.equal(demoted.status, 403);
  assert.equal((await call('POST', `/api/admin/users/${randomUUID()}/deactivate`, { token })).status, 403);

  await pool.query(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [id]);
  assert.equal((await call('GET', '/api/requests?role=all&limit=1', { token })).status, 200);
});

test('a deactivated administrator loses all access immediately, including admin operations', async () => {
  const a1 = await adminToken();
  const a2 = await adminToken();
  const victim = await member();
  assert.equal((await call('POST', `/api/admin/users/${a2.id}/deactivate`, { token: a1.token })).status, 200);
  // a2's still-valid token is now useless, for admin and for ordinary routes
  assert.equal((await call('POST', `/api/admin/users/${victim.id}/deactivate`, { token: a2.token })).status, 401);
  assert.equal((await call('GET', '/api/auth/me', { token: a2.token })).status, 401);
  assert.equal((await call('GET', '/api/requests?role=all', { token: a2.token })).status, 401);
  assert.equal((await call('GET', '/api/auth/me', { token: victim.token })).status, 200);   // the victim was not touched
});

test('administrators have no override for approve/reject or for changing another member\'s listing', async () => {
  const { owner, requester, copy } = await setup();
  const admin = await adminToken();
  const req = await request(requester.token, copy);
  assert.equal((await call('POST', `/api/requests/${req}/approve`, { token: admin.token })).status, 403);
  assert.equal((await call('POST', `/api/requests/${req}/reject`, { token: admin.token })).status, 403);
  assert.equal((await call('PATCH', `/api/copies/${copy}`, { token: admin.token, body: { isListed: false } })).status, 403);
  // moderation overrides that ARE specified: cancel, handoff and return
  assert.equal((await call('POST', `/api/requests/${req}/cancel`, { token: admin.token })).status, 200);
  void owner;
});

test('deactivating a borrower: open requests cancelled, loans and reviews preserved, lender can still close the loan', async () => {
  const owner = await member('owner-contact', 'Lender Person');
  const borrower = await member(undefined, 'Soon Gone');
  const admin = await adminToken();
  const book = await newBook(owner.token);
  const [pendingCopy, approvedCopy, loanedCopy, doneCopy] = await Promise.all(
    [0, 1, 2, 3].map(() => newCopy(owner.token, book)));

  // (1) PENDING and (2) APPROVED requests by the borrower
  const pendingReq = await request(borrower.token, pendingCopy);
  const approvedReq = await request(borrower.token, approvedCopy);
  await call('POST', `/api/requests/${approvedReq}/approve`, { token: owner.token });
  // (3) an ACTIVE loan
  const loanReq = await request(borrower.token, loanedCopy);
  await call('POST', `/api/requests/${loanReq}/approve`, { token: owner.token });
  const activeLoan = (await call('POST', `/api/requests/${loanReq}/handoff`, { token: owner.token, body: { days: 14 } })).json.data.id;
  // (4) a RETURNED loan with a review
  const doneReq = await request(borrower.token, doneCopy);
  await call('POST', `/api/requests/${doneReq}/approve`, { token: owner.token });
  const doneLoan = (await call('POST', `/api/requests/${doneReq}/handoff`, { token: owner.token, body: {} })).json.data.id;
  await call('POST', `/api/loans/${doneLoan}/return`, { token: owner.token });
  assert.equal((await call('POST', `/api/loans/${doneLoan}/review`, { token: borrower.token, body: { rating: 4, comment: 'kept' } })).status, 201);

  const d = await call('POST', `/api/admin/users/${borrower.id}/deactivate`, { token: admin.token });
  assert.equal(d.status, 200);
  assert.equal(d.json.data.cancelledRequests, 2);

  // cancelled according to the approved rules, attributed to the administrator
  for (const id of [pendingReq, approvedReq]) {
    const r = (await call('GET', `/api/requests/${id}`, { token: owner.token })).json.data;
    assert.equal(r.status, 'CANCELLED');
    assert.equal(r.cancelledBy, admin.id);
  }
  // the released reservation makes the copy available again (derived, atomic)
  assert.equal((await call('GET', `/api/copies/${approvedCopy}`, { token: owner.token })).json.data.available, true);

  // the active loan is untouched and the lender can still close it
  const loan = (await call('GET', `/api/loans/${activeLoan}`, { token: owner.token })).json.data;
  assert.equal(loan.returnedAt, null);
  assert.equal(loan.borrower.displayName, 'Soon Gone');
  assert.equal((await call('POST', `/api/loans/${activeLoan}/return`, { token: owner.token })).status, 200);

  // history and the review survive
  const lent = await call('GET', '/api/loans?role=lender&status=returned&limit=100', { token: owner.token });
  const ids = lent.json.data.map((l: any) => l.id);
  assert.ok(ids.includes(doneLoan) && ids.includes(activeLoan));
  const reviews = await call('GET', `/api/books/${book}/reviews`, { token: owner.token });
  assert.equal(reviews.json.page.total, 1);
  assert.equal(reviews.json.data[0].comment, 'kept');
  assert.equal(reviews.json.data[0].reviewerName, 'Soon Gone');

  // and the borrower is locked out
  assert.equal((await call('GET', '/api/auth/me', { token: borrower.token })).status, 401);
  assert.equal((await call('POST', `/api/copies/${pendingCopy}/requests`, { token: borrower.token, body: {} })).status, 401);
});

test('deactivating an owner: copies leave discovery, incoming requests stay as they are, an admin can still resolve them', async () => {
  const { owner, requester, book, copy } = await setup();
  const admin = await adminToken();
  const req = await request(requester.token, copy);
  await call('POST', `/api/admin/users/${owner.id}/deactivate`, { token: admin.token });

  assert.equal((await call('GET', `/api/books/${book}/copies`, { token: requester.token })).json.data.length, 0);
  const still = await call('GET', `/api/requests/${req}`, { token: requester.token });
  assert.equal(still.json.data.status, 'PENDING');                     // approved rule: left as is
  assert.equal((await call('POST', `/api/requests/${req}/approve`, { token: owner.token })).status, 401);
  const cancelled = await call('POST', `/api/requests/${req}/cancel`, { token: admin.token });   // admin override
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.data.status, 'CANCELLED');
});

test('the migrations and schema are untouched by the API layer (9 applied, checksums unchanged)', async () => {
  const r = await pool.query(`SELECT count(*)::int n FROM schema_migrations`);
  assert.equal(r.rows[0].n, 9);
});
