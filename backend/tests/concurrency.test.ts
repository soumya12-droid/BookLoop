// Phase 2 concurrency tests: real, separate database connections racing on COMMITTED data.
//
//  A. Deterministic: one transaction is held open (uncommitted) while a second one is started;
//     we assert the second one BLOCKS, then release the first and assert the exact outcome.
//  B. Randomised races: two (or N) service calls started together with a random stagger,
//     repeated P2_ITER times. Each iteration must satisfy the invariant, and every observed
//     outcome pair is tallied and printed ("[tally] ...") so the real interleavings are visible.
//
// Anything outside the expected outcome set fails the test. Deadlock retries must be zero.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Tx } from '../src/db/pool.ts';
import {
  lending, stats, approveRequestTx, returnLoanTx, setListingTx, cancelRequestTx,
} from '../src/services/lending.ts';
import {
  pool, world, mkUser, mkBook, mkCopy, pendingRequest, approvedRequest, committedLoan,
  cleanup, leftovers, requestRow, loanRows, copyRow, race, outcome, label2, tally, sleep,
} from './helpers.ts';

const ITER = Number(process.env.P2_ITER ?? 12);

before(cleanup);
after(async () => {
  console.log(`[tally] deadlock retries observed across the whole suite: ${stats.deadlockRetries}`);
  await cleanup();
  assert.equal(await leftovers(), 0, 'fixtures were not fully removed');
  await pool.end();
});

// ---------- helpers ----------
async function hold(fn: (tx: Tx) => Promise<unknown>) {
  const c = await pool.connect();
  await c.query('BEGIN');
  await c.query(`SET LOCAL lock_timeout = 8000`);
  try {
    await fn(c);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
    throw e;
  }
  return {
    commit: async () => { try { await c.query('COMMIT'); } finally { c.release(); } },
    rollback: async () => { try { await c.query('ROLLBACK'); } finally { c.release(); } },
  };
}

/** Starts `p`, waits `ms`, reports whether it is still pending (i.e. genuinely blocked on a lock). */
function watch<T>(p: Promise<T>) {
  let state: 'pending' | 'ok' | 'fail' = 'pending';
  let code = '';
  const done = p.then(
    () => { state = 'ok'; },
    (e: { code?: string }) => { state = 'fail'; code = e.code ?? String(e); },
  );
  return { done, get state() { return state; }, get code() { return code; } };
}

const approvedCount = async (copy: string) =>
  Number((await pool.query(`SELECT count(*) FROM borrow_requests WHERE copy_id=$1 AND status='APPROVED'`, [copy])).rows[0].count);
const activeLoanCount = async (copy: string) =>
  Number((await pool.query(`SELECT count(*) FROM loans WHERE copy_id=$1 AND returned_at IS NULL`, [copy])).rows[0].count);

// =====================================================================================
// A. Deterministic blocking tests
// =====================================================================================
test('A1 an in-flight approval blocks a sibling approval, which then fails COPY_RESERVED', async () => {
  const w = await world();
  const r1 = await pendingRequest(w.copy, w.b1);
  const r2 = await pendingRequest(w.copy, w.b2);
  const h = await hold((tx) => approveRequestTx(tx, w.owner, r1));
  const b = watch(lending.approveRequest(pool, w.owner, r2));
  await sleep(600);
  assert.equal(b.state, 'pending', 'second approval must be blocked on the copy lock');
  await h.commit();
  await b.done;
  assert.deepEqual([b.state, b.code], ['fail', 'COPY_RESERVED']);
  assert.equal(await approvedCount(w.copy), 1);
});

test('A2 an in-flight delist blocks an approval, which then fails COPY_UNLISTED', async () => {
  const w = await world();
  const r = await pendingRequest(w.copy, w.b1);
  const h = await hold((tx) => setListingTx(tx, w.owner, w.copy, false));
  const b = watch(lending.approveRequest(pool, w.owner, r));
  await sleep(600);
  assert.equal(b.state, 'pending');
  await h.commit();
  await b.done;
  assert.deepEqual([b.state, b.code], ['fail', 'COPY_UNLISTED']);
  assert.equal((await copyRow(w.copy)).is_listed, false);
  assert.equal(await approvedCount(w.copy), 0);
});

test('A3 an in-flight approval blocks a delist, which then fails COPY_RESERVED', async () => {
  const w = await world();
  const r = await pendingRequest(w.copy, w.b1);
  const h = await hold((tx) => approveRequestTx(tx, w.owner, r));
  const b = watch(lending.setListing(pool, w.owner, w.copy, false));
  await sleep(600);
  assert.equal(b.state, 'pending');
  await h.commit();
  await b.done;
  assert.deepEqual([b.state, b.code], ['fail', 'COPY_RESERVED']);
  assert.equal((await copyRow(w.copy)).is_listed, true);
});

test('A4 an in-flight return blocks a new approval, which then SUCCEEDS once the return commits', async () => {
  const w = await world();
  const { loanId } = await committedLoan(w.copy, w.b1);
  const waiting = await pendingRequest(w.copy, w.b2);
  const h = await hold((tx) => returnLoanTx(tx, w.owner, loanId));
  const b = watch(lending.approveRequest(pool, w.owner, waiting));
  await sleep(600);
  assert.equal(b.state, 'pending');
  await h.commit();
  await b.done;
  assert.equal(b.state, 'ok');
  assert.equal((await requestRow(waiting)).status, 'APPROVED');
  assert.equal(await activeLoanCount(w.copy), 0);
});

test('A5 an approval started while a loan is still active is refused COPY_ON_LOAN (no waiting needed)', async () => {
  const w = await world();
  await committedLoan(w.copy, w.b1);
  const r = await pendingRequest(w.copy, w.b2);
  const e = await outcome(lending.approveRequest(pool, w.owner, r));
  assert.deepEqual(e, { ok: false, code: 'COPY_ON_LOAN' });
});

test('A6 creating a request while an approval is in flight blocks, then fails COPY_UNAVAILABLE (no waitlist, D-3)', async () => {
  const w = await world();
  const r1 = await pendingRequest(w.copy, w.b1);
  const h = await hold((tx) => approveRequestTx(tx, w.owner, r1));
  const b = watch(lending.createRequest(pool, w.b2, w.copy));
  await sleep(600);
  assert.equal(b.state, 'pending');
  await h.commit();
  await b.done;
  assert.deepEqual([b.state, b.code], ['fail', 'COPY_UNAVAILABLE']);
});

test('A7 an in-flight owner no-show cancellation blocks a sibling approval, which then succeeds', async () => {
  const w = await world();
  const approved = await approvedRequest(w.copy, w.b1);
  const sib = await pendingRequest(w.copy, w.b2);
  const h = await hold((tx) => cancelRequestTx(tx, w.owner, approved));
  const b = watch(lending.approveRequest(pool, w.owner, sib));
  await sleep(600);
  assert.equal(b.state, 'pending');
  await h.commit();
  await b.done;
  assert.equal(b.state, 'ok');
  assert.equal((await requestRow(approved)).status, 'CANCELLED');
  assert.equal(await approvedCount(w.copy), 1);
});

test('A8 lock_timeout: a blocked caller gives up with RESOURCE_BUSY instead of waiting forever', async () => {
  const w = await world();
  const r1 = await pendingRequest(w.copy, w.b1);
  const r2 = await pendingRequest(w.copy, w.b2);
  const h = await hold((tx) => approveRequestTx(tx, w.owner, r1));
  const started = Date.now();
  const o = await outcome(lending.approveRequest(pool, w.owner, r2, { lockTimeoutMs: 400 }));
  const waited = Date.now() - started;
  await h.commit();
  assert.deepEqual(o, { ok: false, code: 'RESOURCE_BUSY' });
  assert.ok(waited >= 350 && waited < 4000, `waited ${waited}ms`);
  assert.equal((await requestRow(r2)).status, 'PENDING');
});

test('A9 PRD section 1 item 1: a transaction that BEGAN before a handoff can still record the return', async () => {
  // Early transaction starts at t0 (now() = t0). The handoff then runs and commits with borrowed_at = t1 > t0.
  // The return, executed inside the early transaction, must not write returned_at = t0 (< borrowed_at).
  const w = await world();
  const req = await approvedRequest(w.copy, w.b1);
  const early = await pool.connect();
  try {
    await early.query('BEGIN');
    await early.query('SELECT 1');                       // now() is fixed here
    await sleep(50);
    const loan = await lending.handoff(pool, w.owner, req, 14);    // commits with borrowed_at > early's now()
    const stamp = (await early.query(`SELECT now() AS t0`)).rows[0].t0 as Date;
    assert.ok(loan.borrowed_at > stamp, 'precondition: early transaction started before the handoff');

    // Negative control: the naive now() would violate ck_loans_returned.
    await early.query('SAVEPOINT naive');
    await assert.rejects(
      early.query(`UPDATE loans SET returned_at = now() WHERE id = $1`, [loan.id]),
      (e: { code?: string; constraint?: string }) => e.code === '23514' && e.constraint === 'ck_loans_returned');
    await early.query('ROLLBACK TO SAVEPOINT naive');

    // The service uses clock_timestamp() and succeeds inside the same early transaction.
    const returned = await returnLoanTx(early, w.owner, loan.id);
    assert.ok(returned.returned_at && returned.returned_at >= returned.borrowed_at);
    await early.query('COMMIT');
  } catch (e) {
    await early.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    early.release();
  }
});

// =====================================================================================
// B. Randomised races (ITER iterations each)
// =====================================================================================
test(`B1 two borrowers request the same copy simultaneously: both succeed (x${ITER})`, async () => {
  const t = tally();
  for (let i = 0; i < ITER; i++) {
    const w = await world();
    const [a, b] = await race(() => lending.createRequest(pool, w.b1, w.copy), () => lending.createRequest(pool, w.b2, w.copy));
    assert.deepEqual([a, b], [{ ok: true }, { ok: true }]);
    const n = await pool.query(`SELECT count(*)::int n FROM borrow_requests WHERE copy_id=$1 AND status='PENDING'`, [w.copy]);
    assert.equal(n.rows[0].n, 2);
    t.add('both OK');
  }
  console.log(`[tally] B1 ${t}`);
});

test(`B2 two approvals of DIFFERENT requests race: exactly one wins (x${ITER})`, async () => {
  const t = tally();
  for (let i = 0; i < ITER; i++) {
    const w = await world();
    const [r1, r2] = await Promise.all([pendingRequest(w.copy, w.b1), pendingRequest(w.copy, w.b2)]);
    const [a, b] = await race(() => lending.approveRequest(pool, w.owner, r1), () => lending.approveRequest(pool, w.owner, r2));
    const oks = [a, b].filter((o) => o.ok).length;
    assert.equal(oks, 1, `exactly one approval must win, got ${label2(a)} / ${label2(b)}`);
    const loser = [a, b].find((o) => !o.ok)!;
    assert.deepEqual(loser, { ok: false, code: 'COPY_RESERVED' });
    assert.equal(await approvedCount(w.copy), 1);
    t.add('one OK + one COPY_RESERVED');
  }
  console.log(`[tally] B2 ${t}`);
});

test(`B3 the SAME request approved twice concurrently: exactly one wins (x${ITER})`, async () => {
  const t = tally();
  for (let i = 0; i < ITER; i++) {
    const w = await world();
    const r = await pendingRequest(w.copy, w.b1);
    const [a, b] = await race(() => lending.approveRequest(pool, w.owner, r), () => lending.approveRequest(pool, w.owner, r));
    assert.equal([a, b].filter((o) => o.ok).length, 1);
    assert.deepEqual([a, b].find((o) => !o.ok), { ok: false, code: 'INVALID_STATE' });
    t.add('one OK + one INVALID_STATE');
  }
  console.log(`[tally] B3 ${t}`);
});

async function sixWay(lockTimeoutMs: number | undefined, allowed: string[], iterations: number) {
  const t = tally();
  for (let i = 0; i < iterations; i++) {
    const owner = await mkUser(); const book = await mkBook(); const copy = await mkCopy(owner, book);
    const borrowers = await Promise.all(Array.from({ length: 6 }, () => mkUser()));
    const reqs = await Promise.all(borrowers.map((b) => pendingRequest(copy, b)));
    const res = await Promise.all(reqs.map((r) =>
      outcome(lending.approveRequest(pool, owner, r, lockTimeoutMs ? { lockTimeoutMs } : undefined))));
    const oks = res.filter((o) => o.ok).length;
    const losers = res.filter((o): o is { ok: false; code: string } => !o.ok).map((o) => o.code);
    // The integrity invariant, independent of timing: never more than ONE reservation.
    assert.equal(await approvedCount(copy), oks, `approved rows must equal successful approvals`);
    assert.ok(oks <= 1, `more than one approval succeeded: ${res.map(label2).join(', ')}`);
    assert.ok(losers.every((c) => allowed.includes(c)),
      `unexpected loser codes, observed: ${res.map(label2).join(', ')}`);
    t.add(`${oks} OK, ${losers.filter((c) => c === 'COPY_RESERVED').length} COPY_RESERVED, ${losers.filter((c) => c === 'RESOURCE_BUSY').length} RESOURCE_BUSY`);
  }
  return t;
}

test(`B4 six borrowers' requests approved concurrently (default 3s lock_timeout): never more than one reservation`, async () => {
  // At ~260 ms per round trip each transaction holds the lock for seconds, so later waiters may hit
  // lock_timeout (RESOURCE_BUSY). That is a safe, retryable outcome; double reservation is not.
  const t = await sixWay(undefined, ['COPY_RESERVED', 'RESOURCE_BUSY'], Math.max(3, Math.floor(ITER / 3)));
  console.log(`[tally] B4 ${t}`);
});

test('B4b the same six-way race with a generous lock_timeout: exactly one wins, five are COPY_RESERVED', async () => {
  const t = await sixWay(60_000, ['COPY_RESERVED'], 3);
  for (const k of t.map.keys()) assert.equal(k, '1 OK, 5 COPY_RESERVED, 0 RESOURCE_BUSY');
  console.log(`[tally] B4b ${t}`);
});

test(`B5 approve vs delist: never "unlisted AND reserved" (x${ITER})`, async () => {
  const t = tally();
  for (let i = 0; i < ITER; i++) {
    const w = await world();
    const r = await pendingRequest(w.copy, w.b1);
    const [ap, de] = await race(() => lending.approveRequest(pool, w.owner, r), () => lending.setListing(pool, w.owner, w.copy, false));
    const key = `approve=${label2(ap)} delist=${label2(de)}`;
    const okSet = ['approve=OK delist=COPY_RESERVED', 'approve=COPY_UNLISTED delist=OK'];
    assert.ok(okSet.includes(key), key);
    const listed = (await copyRow(w.copy)).is_listed as boolean;
    const approved = await approvedCount(w.copy);
    assert.ok(!( !listed && approved > 0), `inconsistent: listed=${listed} approved=${approved}`);
    t.add(key);
  }
  console.log(`[tally] B5 ${t}`);
});

test(`B6 return vs approval of a waiting request: return always wins; never APPROVED + active loan (x${ITER})`, async () => {
  const t = tally();
  for (let i = 0; i < ITER; i++) {
    const w = await world();
    const { loanId } = await committedLoan(w.copy, w.b1);
    const waiting = await pendingRequest(w.copy, w.b2);
    const [ret, ap] = await race(() => lending.returnLoan(pool, w.owner, loanId), () => lending.approveRequest(pool, w.owner, waiting));
    assert.deepEqual(ret, { ok: true });
    const key = `return=OK approve=${label2(ap)}`;
    assert.ok(['return=OK approve=OK', 'return=OK approve=COPY_ON_LOAN'].includes(key), key);
    assert.equal(await activeLoanCount(w.copy), 0);
    const st = (await requestRow(waiting)).status;
    assert.equal(st, ap.ok ? 'APPROVED' : 'PENDING');
    t.add(key);
  }
  console.log(`[tally] B6 ${t}`);
});

test(`B7 the same return called twice concurrently: one OK, one ALREADY_RETURNED, one timestamp (x${ITER})`, async () => {
  const t = tally();
  for (let i = 0; i < ITER; i++) {
    const w = await world();
    const { loanId } = await committedLoan(w.copy, w.b1);
    const [a, b] = await race(() => lending.returnLoan(pool, w.owner, loanId), () => lending.returnLoan(pool, w.owner, loanId));
    assert.equal([a, b].filter((o) => o.ok).length, 1);
    assert.deepEqual([a, b].find((o) => !o.ok), { ok: false, code: 'ALREADY_RETURNED' });
    const l = (await pool.query(`SELECT returned_at FROM loans WHERE id=$1`, [loanId])).rows[0];
    assert.ok(l.returned_at);
    t.add('one OK + one ALREADY_RETURNED');
  }
  console.log(`[tally] B7 ${t}`);
});

test(`B8 handoff double-click: one loan only (x${ITER})`, async () => {
  const t = tally();
  for (let i = 0; i < ITER; i++) {
    const w = await world();
    const req = await approvedRequest(w.copy, w.b1);
    const [a, b] = await race(() => lending.handoff(pool, w.owner, req, 14), () => lending.handoff(pool, w.owner, req, 14));
    assert.equal([a, b].filter((o) => o.ok).length, 1);
    const loser = [a, b].find((o) => !o.ok) as { code: string };
    assert.ok(['ALREADY_FULFILLED', 'INVALID_STATE'].includes(loser.code), loser.code);
    assert.equal((await loanRows(req)).length, 1);
    assert.equal((await requestRow(req)).status, 'FULFILLED');
    t.add(`one OK + one ${loser.code}`);
  }
  console.log(`[tally] B8 ${t}`);
});

test(`B9 requester cancel vs owner handoff: never a loan for a cancelled request (x${ITER})`, async () => {
  const t = tally();
  for (let i = 0; i < ITER; i++) {
    const w = await world();
    const req = await approvedRequest(w.copy, w.b1);
    const [c, h] = await race(() => lending.cancelRequest(pool, w.b1, req), () => lending.handoff(pool, w.owner, req, 14));
    const key = `cancel=${label2(c)} handoff=${label2(h)}`;
    assert.ok(['cancel=OK handoff=INVALID_STATE', 'cancel=INVALID_STATE handoff=OK'].includes(key), key);
    const st = (await requestRow(req)).status;
    const loans = (await loanRows(req)).length;
    assert.ok((st === 'CANCELLED' && loans === 0) || (st === 'FULFILLED' && loans === 1), `${st}/${loans}`);
    t.add(key);
  }
  console.log(`[tally] B9 ${t}`);
});

test(`B10 requester cancel vs owner cancel of an approved request: one wins (x${ITER})`, async () => {
  const t = tally();
  for (let i = 0; i < ITER; i++) {
    const w = await world();
    const req = await approvedRequest(w.copy, w.b1);
    const [a, b] = await race(() => lending.cancelRequest(pool, w.b1, req), () => lending.cancelRequest(pool, w.owner, req));
    assert.equal([a, b].filter((o) => o.ok).length, 1);
    assert.deepEqual([a, b].find((o) => !o.ok), { ok: false, code: 'INVALID_STATE' });
    const row = await requestRow(req);
    assert.equal(row.status, 'CANCELLED');
    assert.ok([w.b1, w.owner].includes(row.cancelled_by));
    t.add(`cancelled_by=${row.cancelled_by === w.b1 ? 'requester' : 'owner'}`);
  }
  console.log(`[tally] B10 ${t}`);
});

test(`B11 create request vs approve of an earlier request: at most one reservation (x${ITER})`, async () => {
  const t = tally();
  for (let i = 0; i < ITER; i++) {
    const w = await world();
    const r1 = await pendingRequest(w.copy, w.b1);
    const [ap, cr] = await race(() => lending.approveRequest(pool, w.owner, r1), () => lending.createRequest(pool, w.b2, w.copy));
    assert.deepEqual(ap, { ok: true });
    const key = `approve=OK create=${label2(cr)}`;
    assert.ok(['approve=OK create=OK', 'approve=OK create=COPY_UNAVAILABLE'].includes(key), key);
    assert.equal(await approvedCount(w.copy), 1);
    t.add(key);
  }
  console.log(`[tally] B11 ${t}`);
});

test(`B12 deactivate a member vs approve their pending request: always ends CANCELLED, never APPROVED (x${ITER})`, async () => {
  const t = tally();
  for (let i = 0; i < ITER; i++) {
    const w = await world();
    const r = await pendingRequest(w.copy, w.b1);
    const [de, ap] = await race(() => lending.deactivateUser(pool, w.admin, w.b1), () => lending.approveRequest(pool, w.owner, r));
    assert.deepEqual(de, { ok: true });
    const key = `deactivate=OK approve=${label2(ap)}`;
    assert.ok(
      ['deactivate=OK approve=OK', 'deactivate=OK approve=INVALID_STATE', 'deactivate=OK approve=REQUESTER_DEACTIVATED'].includes(key), key);
    assert.equal((await requestRow(r)).status, 'CANCELLED');
    assert.equal(await approvedCount(w.copy), 0);
    t.add(key);
  }
  console.log(`[tally] B12 ${t}`);
});

test('B13 no deadlocks occurred in the whole run', () => {
  assert.equal(stats.deadlockRetries, 0, 'a deadlock/serialisation retry was needed');
});
