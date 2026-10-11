// T-G verified with REAL COMMITs (Phase 1 only exercised SET CONSTRAINTS ... IMMEDIATE inside
// rolled-back transactions). Both directions: loan => request FULFILLED, and FULFILLED => loan.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { pool, world, approvedRequest, cleanup, leftovers, requestRow, loanRows } from './helpers.ts';

before(cleanup);
after(async () => {
  await cleanup();
  assert.equal(await leftovers(), 0, 'fixtures were not fully removed');
  await pool.end();
});

const LOAN_SQL = `INSERT INTO loans (request_id, copy_id, borrower_id, lender_id, due_at)
                  SELECT r.id, r.copy_id, r.requester_id, c.owner_id, now() + interval '14 days'
                  FROM borrow_requests r JOIN copies c ON c.id = r.copy_id WHERE r.id = $1`;

async function inOwnTx(fn: (c: pg.PoolClient) => Promise<void>): Promise<unknown> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
    await c.query('COMMIT');
    return null;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    return e;
  } finally {
    c.release();
  }
}
const code = (e: unknown) => (e as { code?: string } | null)?.code;

test('T-G: normal handoff (loan first, then FULFILLED) COMMITS and is visible to other connections', async () => {
  const w = await world();
  const req = await approvedRequest(w.copy, w.b1);
  const err = await inOwnTx(async (c) => {
    await c.query(LOAN_SQL, [req]);
    await c.query(`UPDATE borrow_requests SET status='FULFILLED' WHERE id=$1`, [req]);
  });
  assert.equal(err, null, `handoff should commit, got ${code(err)}`);
  assert.equal((await requestRow(req)).status, 'FULFILLED');
  assert.equal((await loanRows(req)).length, 1);
});

test('T-G direction 1: a loan whose request is still APPROVED cannot COMMIT (LD012); nothing persists', async () => {
  const w = await world();
  const req = await approvedRequest(w.copy, w.b1);
  const err = await inOwnTx(async (c) => { await c.query(LOAN_SQL, [req]); /* request NOT flipped */ });
  assert.equal(code(err), 'LD012');
  assert.equal((await requestRow(req)).status, 'APPROVED');
  assert.equal((await loanRows(req)).length, 0);
});

test('T-G direction 1b: a loan whose request ends CANCELLED in the same transaction cannot COMMIT (LD012)', async () => {
  const w = await world();
  const req = await approvedRequest(w.copy, w.b1);
  const err = await inOwnTx(async (c) => {
    await c.query(LOAN_SQL, [req]);
    await c.query(
      `UPDATE borrow_requests SET status='CANCELLED', cancelled_at=clock_timestamp(), cancelled_by=$2 WHERE id=$1`,
      [req, w.owner]);
  });
  assert.equal(code(err), 'LD012');
  assert.equal((await requestRow(req)).status, 'APPROVED');
  assert.equal((await loanRows(req)).length, 0);
});

test('T-G direction 2: a FULFILLED request without a loan cannot COMMIT (LD006); T-B is left enabled', async () => {
  const w = await world();
  const req = await approvedRequest(w.copy, w.b1);
  try {
    // T-B would stop this immediately; disable it for this transaction only so that T-G is what fires.
    const err = await inOwnTx(async (c) => {
      await c.query('ALTER TABLE borrow_requests DISABLE TRIGGER trg_requests_before_update');
      await c.query(`UPDATE borrow_requests SET status='FULFILLED' WHERE id=$1`, [req]);
    });
    assert.equal(code(err), 'LD006');
    assert.equal((await requestRow(req)).status, 'APPROVED');
  } finally {
    await pool.query('ALTER TABLE borrow_requests ENABLE TRIGGER trg_requests_before_update'); // idempotent safety
  }
  const t = await pool.query(
    `SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_requests_before_update'`);
  assert.equal(t.rows[0].tgenabled, 'O', 'T-B must be enabled after the test');
});

test('ordering: FULFILLED before the loan exists is rejected immediately (LD006), so loan-first is required', async () => {
  const w = await world();
  const req = await approvedRequest(w.copy, w.b1);
  const err = await inOwnTx(async (c) => {
    await c.query(`UPDATE borrow_requests SET status='FULFILLED' WHERE id=$1`, [req]);
    await c.query(LOAN_SQL, [req]);
  });
  assert.equal(code(err), 'LD006');
  assert.equal((await requestRow(req)).status, 'APPROVED');
});
