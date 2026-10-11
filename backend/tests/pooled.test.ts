// Does the application's data path work through Neon's pooled endpoint (PgBouncer, transaction mode)?
// The pooled hostname is derived from the verified TEST endpoint only. Fixtures are created through
// the direct pool from helpers.ts; the code under test runs through the pooled pool.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/db/pool.ts';
import {
  lending, approveRequestTx,
} from '../src/services/lending.ts';
import { testPooledUrl } from '../db/lib/pooled.mjs';
import {
  pool as direct, world, mkUser, mkBook, mkCopy, pendingRequest, approvedRequest, committedLoan,
  cleanup, leftovers, requestRow, loanRows, sleep,
} from './helpers.ts';

const pooled = createPool(testPooledUrl(), 6);

before(cleanup);
after(async () => {
  await pooled.end();
  await cleanup();
  assert.equal(await leftovers(), 0, 'fixtures were not fully removed');
  await direct.end();
});

test('pooled: connects (TLS, channel binding as configured) and serves parameterised queries', async () => {
  const r = await pooled.query('SELECT $1::int AS n, current_database() AS db', [41 + 1]);
  assert.equal(r.rows[0].n, 42);
  assert.equal(r.rows[0].db, 'neondb');
});

test('pooled: 24 concurrent parameterised statements all succeed (no prepared-statement collisions)', async () => {
  const res = await Promise.all(Array.from({ length: 24 }, (_, i) =>
    pooled.query('SELECT $1::int + $2::int AS s', [i, 100])));
  assert.deepEqual(res.map((r) => r.rows[0].s), Array.from({ length: 24 }, (_, i) => i + 100));
});

test('pooled: SET LOCAL lock_timeout is transaction-scoped and does not leak between pooled sessions', async () => {
  for (let i = 0; i < 12; i++) {
    const c = await pooled.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL lock_timeout = 777');
      const inTx = (await c.query('SHOW lock_timeout')).rows[0].lock_timeout;
      assert.equal(inTx, '777ms');
      await c.query('COMMIT');
      const after = (await c.query('SHOW lock_timeout')).rows[0].lock_timeout;
      assert.notEqual(after, '777ms');
    } finally { c.release(); }
  }
  // and a brand-new transaction from the service layer sees only its own setting
  const w = await world();
  const r = await pendingRequest(w.copy, w.b1);
  await lending.approveRequest(pooled, w.owner, r, { lockTimeoutMs: 1234 });
});

test('pooled: full lending lifecycle (request, approve, handoff, return, review) through the pooler', async () => {
  const w = await world();
  const req = await lending.createRequest(pooled, w.b1, w.copy, 'via pooler');
  assert.equal(req.status, 'PENDING');
  await lending.approveRequest(pooled, w.owner, req.id);
  const loan = await lending.handoff(pooled, w.owner, req.id, 7);
  assert.equal((await requestRow(req.id)).status, 'FULFILLED');   // T-G satisfied at COMMIT through the pooler
  const returned = await lending.returnLoan(pooled, w.owner, loan.id);
  assert.ok(returned.returned_at);
  const rv = await lending.createReview(pooled, w.b1, loan.id, 5, 'works');
  assert.equal(rv.rating, 5);
});

test('pooled: the deferred T-G check still fires at COMMIT (a loan without FULFILLED cannot commit)', async () => {
  const w = await world();
  const req = await approvedRequest(w.copy, w.b1);
  const c = await pooled.connect();
  let err: { code?: string } | null = null;
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO loans (request_id, copy_id, borrower_id, lender_id, due_at)
       VALUES ($1,$2,$3,$4, now() + interval '7 days')`, [req, w.copy, w.b1, w.owner]);
    await c.query('COMMIT');
  } catch (e) {
    err = e as { code?: string };
    await c.query('ROLLBACK').catch(() => {});
  } finally { c.release(); }
  assert.equal(err?.code, 'LD012');
  assert.equal((await loanRows(req)).length, 0);
});

test('pooled: row locks block across pooled sessions and release on COMMIT (approval vs sibling approval)', async () => {
  const w = await world();
  const [r1, r2] = await Promise.all([pendingRequest(w.copy, w.b1), pendingRequest(w.copy, w.b2)]);
  const holder = await pooled.connect();
  await holder.query('BEGIN');
  await holder.query('SET LOCAL lock_timeout = 8000');
  await approveRequestTx(holder, w.owner, r1);                     // uncommitted, holds the copy lock

  let state = 'pending'; let failCode = '';
  const other = lending.approveRequest(pooled, w.owner, r2).then(
    () => { state = 'ok'; }, (e: { code?: string }) => { state = 'fail'; failCode = e.code ?? ''; });
  await sleep(700);
  assert.equal(state, 'pending', 'the second approval must be blocked on the copy row lock');
  await holder.query('COMMIT');
  holder.release();
  await other;
  assert.deepEqual([state, failCode], ['fail', 'COPY_RESERVED']);
});

test('pooled: lock timeout (55P03) is raised and mapped to RESOURCE_BUSY through the pooler', async () => {
  const w = await world();
  const [r1, r2] = await Promise.all([pendingRequest(w.copy, w.b1), pendingRequest(w.copy, w.b2)]);
  const holder = await pooled.connect();
  await holder.query('BEGIN');
  await holder.query('SET LOCAL lock_timeout = 8000');
  await approveRequestTx(holder, w.owner, r1);
  try {
    await assert.rejects(
      lending.approveRequest(pooled, w.owner, r2, { lockTimeoutMs: 400 }),
      (e: { code?: string; status?: number }) => e.code === 'RESOURCE_BUSY' && e.status === 409);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  assert.equal((await requestRow(r2)).status, 'PENDING');
});

test('pooled: concurrent race (four approvals) still yields exactly one reservation', async () => {
  const owner = await mkUser(); const book = await mkBook(); const copy = await mkCopy(owner, book);
  const borrowers = await Promise.all(Array.from({ length: 4 }, () => mkUser()));
  const reqs = await Promise.all(borrowers.map((b) => pendingRequest(copy, b)));
  const res = await Promise.allSettled(reqs.map((r) =>
    lending.approveRequest(pooled, owner, r, { lockTimeoutMs: 60_000 })));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  const n = await direct.query(`SELECT count(*)::int n FROM borrow_requests WHERE copy_id=$1 AND status='APPROVED'`, [copy]);
  assert.equal(n.rows[0].n, 1);
});

test('pooled: a rolled-back handoff leaves nothing behind and the pooled session stays usable', async () => {
  const w = await world();
  const req = await approvedRequest(w.copy, w.b1);
  await assert.rejects(
    lending.handoff(pooled, w.owner, req, 14, { hooks: { afterLoanInsert: () => { throw new Error('injected'); } } }),
    /injected/);
  assert.equal((await loanRows(req)).length, 0);
  assert.equal((await requestRow(req)).status, 'APPROVED');
  await lending.handoff(pooled, w.owner, req, 14);
  assert.equal((await loanRows(req)).length, 1);
});

test('pooled: overdue block and history reads work through the pooler', async () => {
  const w = await world();
  const held = await mkCopy(w.owner, w.book);
  await committedLoan(held, w.b1, { borrowedAgo: 30, term: 14 });
  await assert.rejects(
    lending.createRequest(pooled, w.b1, w.copy),
    (e: { code?: string }) => e.code === 'OVERDUE_LOANS_BLOCK');
});
