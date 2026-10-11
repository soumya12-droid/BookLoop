// Functional tests for the lending service functions (single actor at a time; no races here).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { lending } from '../src/services/lending.ts';
import { LendingError } from '../src/services/errors.ts';
import {
  pool, world, mkUser, mkBook, mkCopy, pendingRequest, approvedRequest, committedLoan,
  cleanup, leftovers, requestRow, loanRows, copyRow,
} from './helpers.ts';

before(cleanup);
after(async () => {
  await cleanup();
  assert.equal(await leftovers(), 0, 'fixtures were not fully removed');
  await pool.end();
});

async function fails(p: Promise<unknown>, code: string, status?: number) {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof LendingError, `expected LendingError ${code}, got ${String(e)}`);
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (status) assert.equal(e.status, status);
    return e;
  }
  assert.fail(`expected ${code} but the call succeeded`);
}
const availableCopies = async (copy: string) =>
  (await pool.query(`SELECT 1 FROM available_copies WHERE copy_id=$1`, [copy])).rowCount === 1;
const deactivate = (id: string) =>
  pool.query(`UPDATE users SET deactivated_at = clock_timestamp() WHERE id = $1`, [id]);

// ---------- requests ----------
test('create request: happy path; copy stays available while only PENDING', async () => {
  const w = await world();
  const r = await lending.createRequest(pool, w.b1, w.copy, 'Please');
  assert.equal(r.status, 'PENDING');
  assert.equal(r.requester_id, w.b1);
  assert.ok(await availableCopies(w.copy));
});

test('create request: own copy is refused (422 SELF_REQUEST)', async () => {
  const w = await world();
  await fails(lending.createRequest(pool, w.owner, w.copy), 'SELF_REQUEST', 422);
});

test('create request: unlisted copy, deactivated owner, on loan and reserved are all COPY_UNAVAILABLE', async () => {
  const w = await world();
  const unlisted = await mkCopy(w.owner, w.book, false);
  let e = await fails(lending.createRequest(pool, w.b1, unlisted), 'COPY_UNAVAILABLE', 409);
  assert.equal(e.details?.reason, 'UNLISTED');

  const gone = await mkUser(); const goneCopy = await mkCopy(gone, w.book); await deactivate(gone);
  e = await fails(lending.createRequest(pool, w.b1, goneCopy), 'COPY_UNAVAILABLE');
  assert.equal(e.details?.reason, 'OWNER_DEACTIVATED');

  const onLoan = await mkCopy(w.owner, w.book); await committedLoan(onLoan, w.b2);
  e = await fails(lending.createRequest(pool, w.b1, onLoan), 'COPY_UNAVAILABLE');
  assert.equal(e.details?.reason, 'ON_LOAN');

  const reserved = await mkCopy(w.owner, w.book); await approvedRequest(reserved, w.b2);
  e = await fails(lending.createRequest(pool, w.b1, reserved), 'COPY_UNAVAILABLE');
  assert.equal(e.details?.reason, 'RESERVED');
});

test('deactivated user cannot create requests or listings (403 ACCOUNT_DEACTIVATED)', async () => {
  const w = await world();
  await deactivate(w.b1);
  await fails(lending.createRequest(pool, w.b1, w.copy), 'ACCOUNT_DEACTIVATED', 403);
  await fails(lending.createCopy(pool, w.b1, { bookId: w.book }), 'ACCOUNT_DEACTIVATED', 403);
});

test('create request: duplicate open request refused; allowed again after cancel', async () => {
  const w = await world();
  const r = await lending.createRequest(pool, w.b1, w.copy);
  await fails(lending.createRequest(pool, w.b1, w.copy), 'DUPLICATE_OPEN_REQUEST', 409);
  await lending.cancelRequest(pool, w.b1, r.id);
  await lending.createRequest(pool, w.b1, w.copy);
});

test('D-7: overdue borrower cannot create new requests; returning the book lifts it', async () => {
  const w = await world();
  const other = await mkCopy(w.owner, w.book);
  const { loanId } = await committedLoan(other, w.b1, { borrowedAgo: 30, term: 14 }); // due 16 days ago
  const e = await fails(lending.createRequest(pool, w.b1, w.copy), 'OVERDUE_LOANS_BLOCK', 409);
  assert.equal((e.details?.loans as unknown[]).length, 1);
  // the block does not stop other member actions: the borrower can still cancel/withdraw, and
  // the owner returning the book clears it immediately (derived, nothing stored)
  await lending.returnLoan(pool, w.owner, loanId);
  await lending.createRequest(pool, w.b1, w.copy);
});

// ---------- approve / reject ----------
test('approve: only the owner; others get 403 (parties) or 404 (strangers); state rules', async () => {
  const w = await world();
  const stranger = await mkUser();
  const req = await pendingRequest(w.copy, w.b1);
  await fails(lending.approveRequest(pool, w.b1, req), 'FORBIDDEN', 403);      // the requester
  await fails(lending.approveRequest(pool, w.admin, req), 'FORBIDDEN', 403);   // admin has no approval override (D-9)
  await fails(lending.approveRequest(pool, stranger, req), 'REQUEST_NOT_FOUND', 404);
  const ok = await lending.approveRequest(pool, w.owner, req);
  assert.equal(ok.status, 'APPROVED');
  assert.ok(ok.decided_at);
  await fails(lending.approveRequest(pool, w.owner, req), 'INVALID_STATE', 409);
  assert.equal(await availableCopies(w.copy), false);                          // reserved
});

test('approve: a second request cannot be approved while one is APPROVED; sibling stays PENDING', async () => {
  const w = await world();
  const r1 = await pendingRequest(w.copy, w.b1);
  const r2 = await pendingRequest(w.copy, w.b2);
  await lending.approveRequest(pool, w.owner, r1);
  await fails(lending.approveRequest(pool, w.owner, r2), 'COPY_RESERVED', 409);
  assert.equal((await requestRow(r2)).status, 'PENDING');
});

test('approve: refused for an unlisted copy, a deactivated requester, or a copy on loan', async () => {
  const w = await world();
  const r1 = await pendingRequest(w.copy, w.b1);
  await pool.query(`UPDATE copies SET is_listed=false WHERE id=$1`, [w.copy]);
  await fails(lending.approveRequest(pool, w.owner, r1), 'COPY_UNLISTED', 409);
  await pool.query(`UPDATE copies SET is_listed=true WHERE id=$1`, [w.copy]);
  await deactivate(w.b1);
  await fails(lending.approveRequest(pool, w.owner, r1), 'REQUESTER_DEACTIVATED', 409);

  const w2 = await world();
  await committedLoan(w2.copy, w2.b1);
  const r = await pendingRequest(w2.copy, w2.b2);
  await fails(lending.approveRequest(pool, w2.owner, r), 'COPY_ON_LOAN', 409);
});

test('reject: owner only; terminal afterwards', async () => {
  const w = await world();
  const req = await pendingRequest(w.copy, w.b1);
  await fails(lending.rejectRequest(pool, w.b1, req), 'FORBIDDEN', 403);
  const r = await lending.rejectRequest(pool, w.owner, req);
  assert.equal(r.status, 'REJECTED');
  await fails(lending.approveRequest(pool, w.owner, req), 'INVALID_STATE');
  await fails(lending.cancelRequest(pool, w.b1, req), 'INVALID_STATE');
});

// ---------- cancellation / no-show workflow (Clarification 1) ----------
test('cancel matrix: requester PENDING/APPROVED, owner APPROVED only, admin either, stranger 404', async () => {
  const w = await world();
  const stranger = await mkUser();
  const pending = await pendingRequest(w.copy, w.b1);
  await fails(lending.cancelRequest(pool, w.owner, pending), 'FORBIDDEN', 403);       // owner must reject instead
  await fails(lending.cancelRequest(pool, stranger, pending), 'REQUEST_NOT_FOUND', 404);
  const c1 = await lending.cancelRequest(pool, w.b1, pending);                         // requester withdraws
  assert.equal(c1.status, 'CANCELLED'); assert.equal(c1.cancelled_by, w.b1); assert.equal(c1.decided_at, null);

  const approved = await approvedRequest(w.copy, w.b2);
  const c2 = await lending.cancelRequest(pool, w.owner, approved);                     // owner no-show
  assert.equal(c2.status, 'CANCELLED'); assert.equal(c2.cancelled_by, w.owner); assert.ok(c2.decided_at);

  const a2 = await approvedRequest(w.copy, w.b1);
  const c3 = await lending.cancelRequest(pool, w.admin, a2);                           // admin
  assert.equal(c3.cancelled_by, w.admin);
});

test('cancelling an APPROVED request releases the reservation atomically; a sibling can then be approved', async () => {
  const w = await world();
  const r1 = await approvedRequest(w.copy, w.b1);
  const r2 = await pendingRequest(w.copy, w.b2);
  assert.equal(await availableCopies(w.copy), false);
  await lending.cancelRequest(pool, w.owner, r1);
  assert.equal(await availableCopies(w.copy), true);
  const ok = await lending.approveRequest(pool, w.owner, r2);
  assert.equal(ok.status, 'APPROVED');
});

// ---------- handoff / return ----------
test('handoff: owner (or admin) only; due date = end of day IST, N days ahead; request FULFILLED', async () => {
  const w = await world();
  const req = await approvedRequest(w.copy, w.b1);
  await fails(lending.handoff(pool, w.b1, req, 14), 'FORBIDDEN', 403);
  await fails(lending.handoff(pool, w.owner, req, 0), 'INVALID_LOAN_PERIOD', 422);
  await fails(lending.handoff(pool, w.owner, req, 61), 'INVALID_LOAN_PERIOD', 422);
  await fails(lending.handoff(pool, w.owner, req, 1.5), 'INVALID_LOAN_PERIOD', 422);

  const loan = await lending.handoff(pool, w.owner, req, 10);
  assert.equal(loan.lender_id, w.owner);
  assert.equal(loan.borrower_id, w.b1);
  assert.equal((await requestRow(req)).status, 'FULFILLED');

  const chk = (await pool.query(
    `SELECT (due_at AT TIME ZONE 'Asia/Kolkata') AS local_due,
            ((((borrowed_at AT TIME ZONE 'Asia/Kolkata')::date + 11))::timestamp) AS expected
     FROM loans WHERE id = $1`, [loan.id])).rows[0];
  assert.equal(new Date(chk.local_due).getTime(), new Date(chk.expected).getTime(),
    'due_at must be local midnight starting day (borrowed date + N + 1)');
  assert.equal(await availableCopies(w.copy), false);
  await fails(lending.handoff(pool, w.owner, req, 10), 'ALREADY_FULFILLED', 409);
});

test('handoff by an admin override records the OWNER as lender', async () => {
  const w = await world();
  const req = await approvedRequest(w.copy, w.b1);
  const loan = await lending.handoff(pool, w.admin, req, 7);
  assert.equal(loan.lender_id, w.owner);
});

test('handoff requires an APPROVED request and an active borrower', async () => {
  const w = await world();
  const pending = await pendingRequest(w.copy, w.b1);
  await fails(lending.handoff(pool, w.owner, pending), 'INVALID_STATE', 409);
  const w2 = await world();
  const req = await approvedRequest(w2.copy, w2.b1);
  await deactivate(w2.b1);
  await fails(lending.handoff(pool, w2.owner, req), 'BORROWER_DEACTIVATED', 409);
});

test('return: lender (or admin) only; borrower gets 403; second return is 409; copy becomes available', async () => {
  const w = await world();
  const stranger = await mkUser();
  const { loanId } = await committedLoan(w.copy, w.b1);
  await fails(lending.returnLoan(pool, w.b1, loanId), 'FORBIDDEN', 403);
  await fails(lending.returnLoan(pool, stranger, loanId), 'LOAN_NOT_FOUND', 404);
  const r = await lending.returnLoan(pool, w.owner, loanId);
  assert.ok(r.returned_at);
  assert.ok(r.returned_at >= r.borrowed_at);
  assert.equal(await availableCopies(w.copy), true);
  await fails(lending.returnLoan(pool, w.owner, loanId), 'ALREADY_RETURNED', 409);
  await fails(lending.returnLoan(pool, w.admin, loanId), 'ALREADY_RETURNED', 409);
});

test('return then new cycle: the same copy can be requested, approved and lent again', async () => {
  const w = await world();
  const { loanId } = await committedLoan(w.copy, w.b1);
  await lending.returnLoan(pool, w.owner, loanId);
  const req = await lending.createRequest(pool, w.b2, w.copy);
  await lending.approveRequest(pool, w.owner, req.id);
  const loan = await lending.handoff(pool, w.owner, req.id, 14);
  assert.equal(loan.borrower_id, w.b2);
});

// ---------- listings ----------
test('delist is refused while reserved or on loan; relist and ownership rules', async () => {
  const w = await world();
  await fails(lending.setListing(pool, w.b1, w.copy, false), 'COPY_NOT_FOUND', 404);   // not the owner
  await fails(lending.setListing(pool, w.admin, w.copy, false), 'FORBIDDEN', 403);
  const req = await approvedRequest(w.copy, w.b1);
  await fails(lending.setListing(pool, w.owner, w.copy, false), 'COPY_RESERVED', 409);
  await lending.cancelRequest(pool, w.owner, req);
  const c = await lending.setListing(pool, w.owner, w.copy, false);
  assert.equal(c.is_listed, false);
  assert.equal(await availableCopies(w.copy), false);
  assert.equal((await lending.setListing(pool, w.owner, w.copy, true)).is_listed, true);

  const w2 = await world();
  await committedLoan(w2.copy, w2.b1);
  await fails(lending.setListing(pool, w2.owner, w2.copy, false), 'COPY_ON_LOAN', 409);
});

// ---------- reviews ----------
test('review: borrower only, only after return, once, rating 1..5', async () => {
  const w = await world();
  const { loanId } = await committedLoan(w.copy, w.b1);
  await fails(lending.createReview(pool, w.b1, loanId, 5), 'LOAN_NOT_RETURNED', 409);
  await lending.returnLoan(pool, w.owner, loanId);
  await fails(lending.createReview(pool, w.owner, loanId, 5), 'FORBIDDEN', 403);   // lender is a party, not the reviewer
  await fails(lending.createReview(pool, w.b2, loanId, 5), 'LOAN_NOT_FOUND', 404);
  await fails(lending.createReview(pool, w.b1, loanId, 0), 'INVALID_RATING', 422);
  await fails(lending.createReview(pool, w.b1, loanId, 6), 'INVALID_RATING', 422);
  const rv = await lending.createReview(pool, w.b1, loanId, 4, 'Good read');
  assert.equal(rv.rating, 4);
  await fails(lending.createReview(pool, w.b1, loanId, 5), 'ALREADY_REVIEWED', 409);
});

// ---------- administration ----------
test('deactivate: admin only; cancels the requester\'s open requests; keeps loans and history', async () => {
  const w = await world();
  const copy2 = await mkCopy(w.owner, w.book);
  const loanCopy = await mkCopy(w.owner, w.book);
  const pending = await pendingRequest(w.copy, w.b1);
  const approved = await approvedRequest(copy2, w.b1);
  const { loanId } = await committedLoan(loanCopy, w.b1);                     // active loan, must survive

  await fails(lending.deactivateUser(pool, w.owner, w.b1), 'FORBIDDEN', 403);
  await fails(lending.deactivateUser(pool, w.admin, w.admin), 'SELF_DEACTIVATION', 422);
  const res = await lending.deactivateUser(pool, w.admin, w.b1);
  assert.equal(res.cancelledRequests, 2);
  assert.equal((await requestRow(pending)).status, 'CANCELLED');
  const a = await requestRow(approved);
  assert.equal(a.status, 'CANCELLED'); assert.equal(a.cancelled_by, w.admin);
  assert.equal((await pool.query(`SELECT returned_at FROM loans WHERE id=$1`, [loanId])).rows[0].returned_at, null);
  await fails(lending.deactivateUser(pool, w.admin, w.b1), 'ALREADY_DEACTIVATED', 409);
  // the deactivated member cannot act any more, but the lender can still record the return
  await fails(lending.createRequest(pool, w.b1, w.copy), 'ACCOUNT_DEACTIVATED', 403);
  await lending.returnLoan(pool, w.owner, loanId);
});

test('a copy owner who is deactivated stops being discoverable; existing history is retained', async () => {
  const w = await world();
  const { requestId } = await committedLoan(w.copy, w.b1, { borrowedAgo: 10, term: 14, returnedAgo: 2 });
  assert.equal(await availableCopies(w.copy), true);
  await lending.deactivateUser(pool, w.admin, w.owner);
  assert.equal(await availableCopies(w.copy), false);
  assert.equal((await requestRow(requestId)).status, 'FULFILLED');
  assert.equal((await loanRows(requestId)).length, 1);
  assert.equal((await copyRow(w.copy)).owner_id, w.owner);
});

// ---------- atomicity ----------
test('handoff failing after the loan insert rolls everything back (no loan, still APPROVED, reusable)', async () => {
  const w = await world();
  const req = await approvedRequest(w.copy, w.b1);
  await assert.rejects(
    lending.handoff(pool, w.owner, req, 14, {
      hooks: { afterLoanInsert: () => { throw new Error('injected failure'); } },
    }),
    /injected failure/);
  assert.equal((await loanRows(req)).length, 0);
  assert.equal((await requestRow(req)).status, 'APPROVED');
  const loan = await lending.handoff(pool, w.owner, req, 14);   // the pool/connection is healthy
  assert.equal((await loanRows(req)).length, 1);
  assert.equal(loan.request_id, req);
});

test('the book/availability screens never see fixtures of other tests (namespacing sanity)', async () => {
  const w = await world();
  const stray = await pool.query(`SELECT count(*)::int AS n FROM users WHERE id = $1 AND email NOT LIKE 'p2-%@phase2.test'`, [w.owner]);
  assert.equal(stray.rows[0].n, 0);
  assert.ok(await mkBook());
});
