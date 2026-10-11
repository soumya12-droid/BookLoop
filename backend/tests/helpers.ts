// Shared helpers for Phase 2 tests. These tests need COMMITTED data (two real connections race),
// so every fixture is namespaced (users 'p2-<run>-<n>@phase2.test', books 'P2 ...') and removed by
// exact id afterwards. Seed data is never read-modified or deleted. Target: DATABASE_URL_TEST only.
import { assertBranchPin, testTarget } from '../db/lib/env.mjs';
import { createPool } from '../src/db/pool.ts';
import { LendingError } from '../src/services/errors.ts';

const { url, label } = testTarget();
export const pool = createPool(url, 14);
// If TEST_BRANCH_ID is set, refuse to run any suite against a different branch.
await assertBranchPin(pool, 'test');
console.log(`[phase2] target ${label}`);

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const runId = Date.now().toString(36);
let seq = 0;
const nextId = () => `${runId}-${seq++}`;

// ---------- fixtures (committed) ----------
export async function mkUser(role: 'MEMBER' | 'ADMIN' = 'MEMBER'): Promise<string> {
  const n = nextId();
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name, role, created_at)
     VALUES ($1, 'x', $2, $3, now() - interval '1 day') RETURNING id`,
    [`p2-${n}@phase2.test`, `P2 User ${n}`, role]);
  return r.rows[0]!.id;
}

export async function mkBook(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO books (title) VALUES ($1) RETURNING id`, [`P2 Book ${nextId()}`]);
  return r.rows[0]!.id;
}

export async function mkCopy(owner: string, book: string, listed = true): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO copies (book_id, owner_id, is_listed) VALUES ($1, $2, $3) RETURNING id`, [book, owner, listed]);
  return r.rows[0]!.id;
}

/** A PENDING request via plain SQL (no business rules), for building states quickly. */
export async function pendingRequest(copy: string, requester: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO borrow_requests (copy_id, requester_id) VALUES ($1, $2) RETURNING id`, [copy, requester]);
  return r.rows[0]!.id;
}

export async function approvedRequest(copy: string, requester: string): Promise<string> {
  const id = await pendingRequest(copy, requester);
  await pool.query(`UPDATE borrow_requests SET status='APPROVED', decided_at=clock_timestamp() WHERE id=$1`, [id]);
  return id;
}

/**
 * A complete historical loan, replayed through the real lifecycle in ONE transaction (so the
 * commit-time pairing check T-G holds). returnedAgo = null leaves it active.
 */
export async function committedLoan(
  copy: string, borrower: string,
  o: { borrowedAgo?: number; term?: number; returnedAgo?: number | null } = {},
): Promise<{ requestId: string; loanId: string }> {
  const { borrowedAgo = 0, term = 14, returnedAgo = null } = o;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const rid = (await c.query<{ id: string }>(
      `INSERT INTO borrow_requests (copy_id, requester_id, created_at)
       VALUES ($1,$2, now() - make_interval(days => $3::int)) RETURNING id`, [copy, borrower, borrowedAgo + 2])).rows[0]!.id;
    await c.query(
      `UPDATE borrow_requests SET status='APPROVED', decided_at = now() - make_interval(days => $2::int) WHERE id=$1`,
      [rid, borrowedAgo + 1]);
    const lid = (await c.query<{ id: string }>(
      `INSERT INTO loans (request_id, copy_id, borrower_id, lender_id, borrowed_at, due_at, returned_at)
       SELECT r.id, r.copy_id, r.requester_id, cp.owner_id,
              now() - make_interval(days => $2::int),
              now() - make_interval(days => $2::int) + make_interval(days => $3::int),
              CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(days => $4::int) END
       FROM borrow_requests r JOIN copies cp ON cp.id = r.copy_id WHERE r.id = $1 RETURNING id`,
      [rid, borrowedAgo, term, returnedAgo])).rows[0]!.id;
    await c.query(`UPDATE borrow_requests SET status='FULFILLED' WHERE id=$1`, [rid]);
    await c.query('COMMIT');
    return { requestId: rid, loanId: lid };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export interface World { owner: string; b1: string; b2: string; admin: string; book: string; copy: string }
export async function world(): Promise<World> {
  const [owner, b1, b2, admin, book] = await Promise.all([
    mkUser(), mkUser(), mkUser(), mkUser('ADMIN'), mkBook()]);
  const copy = await mkCopy(owner, book);
  return { owner, b1, b2, admin, book, copy };
}

// ---------- assertions / outcome handling ----------
export async function requestRow(id: string) {
  return (await pool.query(`SELECT * FROM borrow_requests WHERE id=$1`, [id])).rows[0];
}
export async function loanRows(requestId: string) {
  return (await pool.query(`SELECT * FROM loans WHERE request_id=$1`, [requestId])).rows;
}
export async function copyRow(id: string) {
  return (await pool.query(`SELECT * FROM copies WHERE id=$1`, [id])).rows[0];
}

export type Outcome = { ok: true } | { ok: false; code: string };
export async function outcome(p: Promise<unknown>): Promise<Outcome> {
  try {
    await p;
    return { ok: true };
  } catch (e) {
    if (e instanceof LendingError) return { ok: false, code: e.code };
    throw e; // an unexpected (non-business) error must fail the test loudly
  }
}
export const label2 = (o: Outcome) => (o.ok ? 'OK' : o.code);

/** Run a then b "simultaneously", with a small random stagger to vary the interleaving. */
export async function race<A, B>(a: () => Promise<A>, b: () => Promise<B>) {
  const jitter = Math.floor(Math.random() * 12);
  const first = Math.random() < 0.5;
  const pa = (async () => { if (!first) await sleep(jitter); return outcome(a()); })();
  const pb = (async () => { if (first) await sleep(jitter); return outcome(b()); })();
  return Promise.all([pa, pb]);
}

/** Count how often each distinct outcome pair was observed. */
export function tally(): { add: (k: string) => void; toString: () => string; map: Map<string, number> } {
  const map = new Map<string, number>();
  return {
    map,
    add: (k) => map.set(k, (map.get(k) ?? 0) + 1),
    toString: () => [...map.entries()].sort().map(([k, v]) => `${k} x${v}`).join(' | '),
  };
}

// ---------- cleanup ----------
export async function cleanup(): Promise<void> {
  const u = (await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email LIKE 'p2-%@phase2.test'`)).rows.map((r) => r.id);
  if (u.length > 0) {
    await pool.query(
      `DELETE FROM reviews WHERE loan_id IN
         (SELECT id FROM loans WHERE borrower_id = ANY($1) OR lender_id = ANY($1))`, [u]);
    await pool.query(`DELETE FROM loans WHERE borrower_id = ANY($1) OR lender_id = ANY($1)`, [u]);
    await pool.query(
      `DELETE FROM borrow_requests WHERE requester_id = ANY($1)
          OR copy_id IN (SELECT id FROM copies WHERE owner_id = ANY($1))`, [u]);
    await pool.query(`DELETE FROM copies WHERE owner_id = ANY($1)`, [u]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [u]);
  }
  await pool.query(
    `DELETE FROM books b WHERE b.title LIKE 'P2 Book %'
        AND NOT EXISTS (SELECT 1 FROM copies c WHERE c.book_id = b.id)`);
}

export async function leftovers(): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM users WHERE email LIKE 'p2-%@phase2.test')
          + (SELECT count(*) FROM books WHERE title LIKE 'P2 Book %') AS n`);
  return Number(r.rows[0]!.n);
}
