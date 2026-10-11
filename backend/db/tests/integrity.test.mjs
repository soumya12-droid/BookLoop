// Phase 1 database integrity tests (DB-01 .. DB-45). Pure SQL against the TEST branch.
// Every test runs inside BEGIN ... ROLLBACK, so nothing is committed. Each expected failure is
// asserted by exact SQLSTATE (and constraint name where the database reports one).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectTest } from '../lib/env.mjs';

let c;
before(async () => { c = await connectTest(); });
after(async () => { await c?.end(); });

// ---------- helpers ----------
let counter = 0;
const uniq = () => `${Date.now().toString(36)}_${(counter++).toString(36)}`;
const one = async (sql, params = []) => (await c.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await c.query(sql, params)).rows;

async function inTx(fn) {
  await c.query('BEGIN');
  try { await fn(); } finally { await c.query('ROLLBACK'); }
}

async function expectFail(sql, params, { code, constraint } = {}) {
  await c.query('SAVEPOINT sp_expect');
  let err = null;
  try { await c.query(sql, params); } catch (e) { err = e; }
  await c.query('ROLLBACK TO SAVEPOINT sp_expect');
  await c.query('RELEASE SAVEPOINT sp_expect');
  assert.ok(err, `expected SQLSTATE ${code} but the statement succeeded: ${sql}`);
  assert.equal(err.code, code, `expected SQLSTATE ${code}, got ${err.code}: ${err.message}`);
  if (Array.isArray(constraint)) {
    assert.ok(constraint.includes(err.constraint), `expected one of ${constraint}, got ${err.constraint}`);
  } else if (constraint) {
    assert.equal(err.constraint, constraint, `expected constraint ${constraint}, got ${err.constraint}`);
  }
}

async function expectOk(sql, params = []) {
  await c.query('SAVEPOINT sp_ok');
  try { return await c.query(sql, params); } finally { await c.query('RELEASE SAVEPOINT sp_ok'); }
}

const FINALISE = 'SET CONSTRAINTS ctrg_request_fulfilment, ctrg_loan_fulfilment IMMEDIATE';

// ---------- fixtures (all inside the current test transaction) ----------
async function mkUser({ role = 'MEMBER', email } = {}) {
  const id = uniq();
  return (await one(
    `INSERT INTO users (email, password_hash, display_name, role) VALUES ($1,'x',$2,$3) RETURNING id`,
    [email ?? `u_${id}@test.local`, `User ${id}`, role])).id;
}
async function mkBook({ isbn = null } = {}) {
  return (await one(`INSERT INTO books (title, isbn) VALUES ($1,$2) RETURNING id`, [`Book ${uniq()}`, isbn])).id;
}
async function mkCopy(owner, book, { listed = true } = {}) {
  return (await one(`INSERT INTO copies (book_id, owner_id, is_listed) VALUES ($1,$2,$3) RETURNING id`, [book, owner, listed])).id;
}
async function mkReq(copy, requester) {
  return (await one(`INSERT INTO borrow_requests (copy_id, requester_id) VALUES ($1,$2) RETURNING id`, [copy, requester])).id;
}
const approve = (req) => c.query(
  `UPDATE borrow_requests SET status='APPROVED', decided_at=clock_timestamp() WHERE id=$1`, [req]);
const reject = (req) => c.query(
  `UPDATE borrow_requests SET status='REJECTED', decided_at=clock_timestamp() WHERE id=$1`, [req]);
const fulfil = (req) => c.query(`UPDATE borrow_requests SET status='FULFILLED' WHERE id=$1`, [req]);
const cancelAs = (req, by) => c.query(
  `UPDATE borrow_requests SET status='CANCELLED', cancelled_at=clock_timestamp(), cancelled_by=$2 WHERE id=$1`, [req, by]);

// Inserts a loan for an (APPROVED) request. borrowedAgo/term in days; returnedAgo null = still active.
const LOAN_FROM_REQUEST = `
  INSERT INTO loans (request_id, copy_id, borrower_id, lender_id, borrowed_at, due_at, returned_at)
  SELECT r.id, r.copy_id, r.requester_id, c.owner_id,
         now() - make_interval(days => $2::int),
         now() - make_interval(days => $2::int) + make_interval(days => $3::int),
         CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(days => $4::int) END
  FROM borrow_requests r JOIN copies c ON c.id = r.copy_id WHERE r.id = $1
  RETURNING id`;
const loanParams = (req, { borrowedAgo = 0, term = 14, returnedAgo = null } = {}) => [req, borrowedAgo, term, returnedAgo];
async function mkLoan(req, opts = {}) { return (await one(LOAN_FROM_REQUEST, loanParams(req, opts))).id; }

// A full world; with `loan` set it replays approve -> loan -> FULFILLED.
async function scenario({ loan = null } = {}) {
  const owner = await mkUser(), borrower = await mkUser(), other = await mkUser();
  const book = await mkBook();
  const copy = await mkCopy(owner, book);
  const req = await mkReq(copy, borrower);
  const s = { owner, borrower, other, book, copy, req, loan: null };
  if (loan) {
    await approve(req);
    s.loan = await mkLoan(req, loan);
    await fulfil(req);
  }
  return s;
}
const newIsbn = () => `978${String(Date.now()).slice(-9).padStart(9, '0')}${counter++ % 10}`;

// ---------- sanity ----------
test('schema is fully migrated (9 migrations applied)', async () => {
  const r = await one('SELECT count(*)::int AS n FROM schema_migrations');
  assert.equal(r.n, 9);
});

// ---------- DB-01 .. DB-07: domain and key constraints ----------
test('DB-01 duplicate email differing only by case is rejected', () => inTx(async () => {
  const email = `Alice_${uniq()}@Example.com`;
  await mkUser({ email });
  await expectFail(`INSERT INTO users (email,password_hash,display_name) VALUES ($1,'x','Dup')`,
    [email.toUpperCase()], { code: '23505', constraint: 'uq_users_email' });
}));

test('DB-02 malformed email is rejected', () => inTx(async () => {
  for (const bad of ['no-at-sign', 'a b@c.test', ' lead@c.test', 'x@']) {
    await expectFail(`INSERT INTO users (email,password_hash,display_name) VALUES ($1,'x','Bad')`,
      [bad], { code: '23514', constraint: 'ck_users_email_format' });
  }
}));

test('DB-03 duplicate ISBN rejected; multiple NULL ISBNs allowed', () => inTx(async () => {
  const isbn = newIsbn();
  await mkBook({ isbn });
  await expectFail(`INSERT INTO books (title, isbn) VALUES ('Dup',$1)`, [isbn], { code: '23505', constraint: 'uq_books_isbn' });
  await mkBook(); await mkBook();            // two NULL ISBNs must both succeed
}));

test('DB-04 malformed ISBN rejected', () => inTx(async () => {
  for (const bad of ['123', '978-0-13-110362-7', '9780131103627X']) {
    await expectFail(`INSERT INTO books (title, isbn) VALUES ('Bad',$1)`, [bad], { code: '23514', constraint: 'ck_books_isbn' });
  }
}));

test('DB-05 invalid foreign key rejected', () => inTx(async () => {
  const owner = await mkUser();
  await expectFail(`INSERT INTO copies (book_id, owner_id) VALUES ($1,$2)`, [randomUUID(), owner], { code: '23503' });
  const book = await mkBook();
  await expectFail(`INSERT INTO copies (book_id, owner_id) VALUES ($1,$2)`, [book, randomUUID()], { code: '23503' });
}));

test('DB-06 invalid role, condition and status are rejected', () => inTx(async () => {
  await expectFail(`INSERT INTO users (email,password_hash,display_name,role) VALUES ($1,'x','R','ROOT')`,
    [`r_${uniq()}@test.local`], { code: '23514', constraint: 'ck_users_role' });
  const owner = await mkUser(); const book = await mkBook();
  await expectFail(`INSERT INTO copies (book_id, owner_id, copy_condition) VALUES ($1,$2,'BROKEN')`,
    [book, owner], { code: '23514', constraint: 'ck_copies_condition' });
  // The status CHECK is shadowed by trigger T-A in normal operation; disable T-A inside this
  // rolled-back transaction to prove the CHECK independently.
  const copy = await mkCopy(owner, book); const req = await mkUser();
  await c.query('ALTER TABLE borrow_requests DISABLE TRIGGER trg_requests_before_insert');
  // An unknown status necessarily violates ck_req_status AND ck_req_columns (no branch matches);
  // PostgreSQL reports whichever it evaluates first, so accept either, with SQLSTATE 23514.
  await expectFail(`INSERT INTO borrow_requests (copy_id, requester_id, status, decided_at) VALUES ($1,$2,'LOST',clock_timestamp())`,
    [copy, req], { code: '23514', constraint: ['ck_req_status', 'ck_req_columns'] });
}));

test('DB-07 rating outside 1..5 is rejected', () => inTx(async () => {
  const s = await scenario({ loan: { borrowedAgo: 5, term: 14, returnedAgo: 1 } });
  for (const bad of [0, 6, -1]) {
    await expectFail(`INSERT INTO reviews (loan_id, rating) VALUES ($1,$2)`, [s.loan, bad],
      { code: '23514', constraint: 'ck_reviews_rating' });
  }
  await expectOk(`INSERT INTO reviews (loan_id, rating) VALUES ($1,5)`, [s.loan]);
}));

// ---------- DB-08 .. DB-16: request rules ----------
test('DB-08 member cannot request their own copy', () => inTx(async () => {
  const owner = await mkUser(); const copy = await mkCopy(owner, await mkBook());
  await expectFail(`INSERT INTO borrow_requests (copy_id, requester_id) VALUES ($1,$2)`, [copy, owner], { code: 'LD002' });
}));

test('DB-09 a request cannot be created already APPROVED', () => inTx(async () => {
  const s = await scenario();
  await expectFail(`INSERT INTO borrow_requests (copy_id, requester_id, status, decided_at) VALUES ($1,$2,'APPROVED',clock_timestamp())`,
    [s.copy, s.other], { code: 'LD001' });
}));

test('DB-10 duplicate open request by the same member for the same copy', () => inTx(async () => {
  const s = await scenario();
  await expectFail(`INSERT INTO borrow_requests (copy_id, requester_id) VALUES ($1,$2)`, [s.copy, s.borrower],
    { code: '23505', constraint: 'uq_req_one_open_per_member_copy' });
  // after cancelling, the same member may request again
  await cancelAs(s.req, s.borrower);
  await expectOk(`INSERT INTO borrow_requests (copy_id, requester_id) VALUES ($1,$2)`, [s.copy, s.borrower]);
}));

test('DB-11 two APPROVED requests for one copy are rejected', () => inTx(async () => {
  const s = await scenario();
  const req2 = await mkReq(s.copy, s.other);
  await approve(s.req);
  await expectFail(`UPDATE borrow_requests SET status='APPROVED', decided_at=clock_timestamp() WHERE id=$1`, [req2],
    { code: '23505', constraint: 'uq_req_one_approved_per_copy' });
}));

test('DB-12 illegal request transitions are rejected', () => inTx(async () => {
  // REJECTED -> APPROVED
  let s = await scenario(); await reject(s.req);
  await expectFail(`UPDATE borrow_requests SET status='APPROVED' WHERE id=$1`, [s.req], { code: 'LD004' });
  // CANCELLED -> PENDING
  s = await scenario(); await cancelAs(s.req, s.borrower);
  await expectFail(`UPDATE borrow_requests SET status='PENDING' WHERE id=$1`, [s.req], { code: 'LD004' });
  // FULFILLED -> CANCELLED
  s = await scenario({ loan: {} });
  await expectFail(`UPDATE borrow_requests SET status='CANCELLED', cancelled_at=clock_timestamp(), cancelled_by=$2 WHERE id=$1`,
    [s.req, s.borrower], { code: 'LD004' });
  // PENDING -> FULFILLED
  s = await scenario();
  await expectFail(`UPDATE borrow_requests SET status='FULFILLED' WHERE id=$1`, [s.req], { code: 'LD004' });
}));

test('DB-13 request identity columns are immutable', () => inTx(async () => {
  const s = await scenario();
  const copy2 = await mkCopy(s.owner, s.book);
  await expectFail(`UPDATE borrow_requests SET copy_id=$2 WHERE id=$1`, [s.req, copy2], { code: 'LD003' });
  await expectFail(`UPDATE borrow_requests SET requester_id=$2 WHERE id=$1`, [s.req, s.other], { code: 'LD003' });
}));

test('DB-14 cannot approve a request while the copy is on loan', () => inTx(async () => {
  const s = await scenario({ loan: {} });
  const req2 = await mkReq(s.copy, s.other);
  await expectFail(`UPDATE borrow_requests SET status='APPROVED', decided_at=clock_timestamp() WHERE id=$1`, [req2], { code: 'LD005' });
}));

test('DB-15 cannot mark a request FULFILLED without a loan', () => inTx(async () => {
  const s = await scenario(); await approve(s.req);
  await expectFail(`UPDATE borrow_requests SET status='FULFILLED' WHERE id=$1`, [s.req], { code: 'LD006' });
}));

test('DB-16 no loan for a PENDING, REJECTED or CANCELLED request', () => inTx(async () => {
  let s = await scenario();                                   // PENDING
  await expectFail(LOAN_FROM_REQUEST, loanParams(s.req), { code: 'LD007' });
  s = await scenario(); await reject(s.req);                  // REJECTED
  await expectFail(LOAN_FROM_REQUEST, loanParams(s.req), { code: 'LD007' });
  s = await scenario(); await cancelAs(s.req, s.borrower);    // CANCELLED
  await expectFail(LOAN_FROM_REQUEST, loanParams(s.req), { code: 'LD007' });
}));

// ---------- DB-17 .. DB-24: loan rules ----------
const RAW_LOAN = `INSERT INTO loans (request_id, copy_id, borrower_id, lender_id, due_at)
                  VALUES ($1,$2,$3,$4, now() + interval '14 days')`;

test('DB-17 loan copy must match the request', () => inTx(async () => {
  const s = await scenario(); await approve(s.req);
  const copy2 = await mkCopy(s.owner, s.book);                // same owner, different copy
  await expectFail(RAW_LOAN, [s.req, copy2, s.borrower, s.owner], { code: '23503', constraint: 'fk_loans_request_match' });
}));

test('DB-18 loan borrower must match the request', () => inTx(async () => {
  const s = await scenario(); await approve(s.req);
  await expectFail(RAW_LOAN, [s.req, s.copy, s.other, s.owner], { code: '23503', constraint: 'fk_loans_request_match' });
}));

test('DB-19 loan lender must be the copy owner', () => inTx(async () => {
  const s = await scenario(); await approve(s.req);
  await expectFail(RAW_LOAN, [s.req, s.copy, s.borrower, s.other], { code: '23503', constraint: 'fk_loans_copy_owner' });
}));

test('DB-20 borrower and lender cannot be the same user', () => inTx(async () => {
  const s = await scenario(); await approve(s.req);
  await expectFail(RAW_LOAN, [s.req, s.copy, s.owner, s.owner], { code: '23514', constraint: 'ck_loans_not_self' });
}));

test('DB-21 a second active loan for one copy is rejected', () => inTx(async () => {
  // T-B would (correctly) stop us approving the second request; disable it for this rolled-back
  // transaction so the partial unique index is exercised on its own. It must be disabled FIRST:
  // PostgreSQL refuses ALTER TABLE once deferred trigger events are pending.
  await c.query('ALTER TABLE borrow_requests DISABLE TRIGGER trg_requests_before_update');
  const s = await scenario({ loan: {} });
  const req2 = await mkReq(s.copy, s.other);
  await approve(req2);
  await expectFail(LOAN_FROM_REQUEST, loanParams(req2), { code: '23505', constraint: 'uq_loans_one_active_per_copy' });
}));

test('DB-22 a second loan for the same request is rejected', () => inTx(async () => {
  const s = await scenario(); await approve(s.req);
  await mkLoan(s.req, { borrowedAgo: 0, term: 14, returnedAgo: 0 });   // first loan already returned
  await expectFail(LOAN_FROM_REQUEST, loanParams(s.req), { code: '23505', constraint: 'uq_loans_request' });
}));

test('DB-23 due_at must be after borrowed_at', () => inTx(async () => {
  const s = await scenario(); await approve(s.req);
  await expectFail(`INSERT INTO loans (request_id, copy_id, borrower_id, lender_id, due_at)
                    VALUES ($1,$2,$3,$4, now() - interval '1 day')`,
    [s.req, s.copy, s.borrower, s.owner], { code: '23514', constraint: 'ck_loans_due' });
}));

test('DB-24 returned_at cannot precede borrowed_at', () => inTx(async () => {
  const s = await scenario(); await approve(s.req);
  await expectFail(`INSERT INTO loans (request_id, copy_id, borrower_id, lender_id, due_at, returned_at)
                    VALUES ($1,$2,$3,$4, now() + interval '14 days', now() - interval '1 day')`,
    [s.req, s.copy, s.borrower, s.owner], { code: '23514', constraint: 'ck_loans_returned' });
  // and via UPDATE of an active loan
  const s2 = await scenario({ loan: {} });
  await expectFail(`UPDATE loans SET returned_at = now() - interval '1 day' WHERE id=$1`, [s2.loan],
    { code: '23514', constraint: 'ck_loans_returned' });
}));

// ---------- DB-25 .. DB-30: history, ownership, reviews, retention ----------
test('DB-25 returned_at cannot be changed once set', () => inTx(async () => {
  const s = await scenario({ loan: { borrowedAgo: 10, term: 14, returnedAgo: 2 } });
  await expectFail(`UPDATE loans SET returned_at = returned_at + interval '1 hour' WHERE id=$1`, [s.loan], { code: 'LD008' });
}));

test('DB-26 copy ownership cannot change (with or without loans)', () => inTx(async () => {
  const s = await scenario();                                 // no loans
  await expectFail(`UPDATE copies SET owner_id=$2 WHERE id=$1`, [s.copy, s.other], { code: 'LD009' });
  const l = await scenario({ loan: {} });                     // with a loan
  await expectFail(`UPDATE copies SET owner_id=$2 WHERE id=$1`, [l.copy, l.other], { code: 'LD009' });
}));

test('DB-27 an unreturned loan cannot be reviewed', () => inTx(async () => {
  const s = await scenario({ loan: {} });
  await expectFail(`INSERT INTO reviews (loan_id, rating) VALUES ($1,4)`, [s.loan], { code: 'LD010' });
}));

test('DB-28 only one review per loan', () => inTx(async () => {
  const s = await scenario({ loan: { borrowedAgo: 6, term: 14, returnedAgo: 1 } });
  await expectOk(`INSERT INTO reviews (loan_id, rating) VALUES ($1,4)`, [s.loan]);
  await expectFail(`INSERT INTO reviews (loan_id, rating) VALUES ($1,5)`, [s.loan], { code: '23505', constraint: 'uq_reviews_loan' });
}));

test('DB-29 deactivation keeps history; hard-deleting a user with history is blocked', () => inTx(async () => {
  const s = await scenario({ loan: { borrowedAgo: 6, term: 14, returnedAgo: 1 } });
  await c.query(`INSERT INTO reviews (loan_id, rating) VALUES ($1,5)`, [s.loan]);
  const counts = () => one(`SELECT
      (SELECT count(*)::int FROM borrow_requests WHERE id=$1) AS req,
      (SELECT count(*)::int FROM loans WHERE id=$2) AS loans,
      (SELECT count(*)::int FROM reviews WHERE loan_id=$2) AS reviews,
      (SELECT count(*)::int FROM copies WHERE id=$3) AS copies`, [s.req, s.loan, s.copy]);
  const before = await counts();
  await c.query(`UPDATE users SET deactivated_at = clock_timestamp() WHERE id = ANY($1)`, [[s.owner, s.borrower]]);
  assert.deepEqual(await counts(), before);
  assert.equal(before.loans, 1);
  // ON DELETE RESTRICT reports 23001 (restrict_violation); NO ACTION would report 23503.
  await expectFail(`DELETE FROM users WHERE id=$1`, [s.owner], { code: '23001' });
  await expectFail(`DELETE FROM users WHERE id=$1`, [s.borrower], { code: '23001' });
}));

test('DB-30 a copy with request history cannot be hard-deleted', () => inTx(async () => {
  const s = await scenario();
  await expectFail(`DELETE FROM copies WHERE id=$1`, [s.copy], { code: '23001' });
}));

// ---------- DB-31 .. DB-33: views ----------
test('DB-31 overdue_loans excludes returned loans', () => inTx(async () => {
  const overdue = await scenario({ loan: { borrowedAgo: 30, term: 14 } });                    // active, due 16d ago
  const lateReturned = await scenario({ loan: { borrowedAgo: 30, term: 14, returnedAgo: 5 } });  // returned late
  const current = await scenario({ loan: { borrowedAgo: 1, term: 14 } });                    // active, not due
  const ids = [overdue.loan, lateReturned.loan, current.loan];
  const rows = await all(`SELECT id FROM overdue_loans WHERE id = ANY($1)`, [ids]);
  assert.deepEqual(rows.map((r) => r.id), [overdue.loan]);
  const act = await all(`SELECT id, is_overdue FROM active_loans WHERE id = ANY($1) ORDER BY id`, [ids]);
  assert.equal(act.length, 2);
  assert.equal(act.find((r) => r.id === overdue.loan).is_overdue, true);
  assert.equal(act.find((r) => r.id === current.loan).is_overdue, false);
}));

test('DB-32 available_copies applies listing, owner status, loans and reservations', () => inTx(async () => {
  const owner = await mkUser(); const book = await mkBook();
  const free = await mkCopy(owner, book);
  const unlisted = await mkCopy(owner, book, { listed: false });
  const deactOwner = await mkUser();
  const ofDeactivated = await mkCopy(deactOwner, book);
  await c.query(`UPDATE users SET deactivated_at = clock_timestamp() WHERE id=$1`, [deactOwner]);
  const onLoan = (await scenario({ loan: {} })).copy;
  const reserved = await scenario(); await approve(reserved.req);
  const pendingOnly = await scenario();                       // PENDING does not block
  const universe = [free, unlisted, ofDeactivated, onLoan, reserved.copy, pendingOnly.copy];
  const rows = await all(`SELECT copy_id FROM available_copies WHERE copy_id = ANY($1)`, [universe]);
  assert.deepEqual(rows.map((r) => r.copy_id).sort(), [free, pendingOnly.copy].sort());
}));

test('DB-33 cancelling an APPROVED request releases the reservation atomically', () => inTx(async () => {
  const s = await scenario(); await approve(s.req);
  const inView = async () => (await all(`SELECT 1 FROM available_copies WHERE copy_id=$1`, [s.copy])).length;
  assert.equal(await inView(), 0);
  await cancelAs(s.req, s.owner);                             // owner no-show cancellation
  assert.equal(await inView(), 1);
  const r = await one(`SELECT status, cancelled_by FROM borrow_requests WHERE id=$1`, [s.req]);
  assert.equal(r.status, 'CANCELLED'); assert.equal(r.cancelled_by, s.owner);
  // and a sibling can now be approved
  const sib = await mkReq(s.copy, s.other);
  await expectOk(`UPDATE borrow_requests SET status='APPROVED', decided_at=clock_timestamp() WHERE id=$1`, [sib]);
}));

test('DB-34 status/timestamp/cancelled_by coherence CHECKs', () => inTx(async () => {
  let s = await scenario();
  await expectFail(`INSERT INTO borrow_requests (copy_id, requester_id, decided_at) VALUES ($1,$2,clock_timestamp())`,
    [s.copy, s.other], { code: '23514', constraint: 'ck_req_columns' });          // PENDING with decided_at
  await expectFail(`UPDATE borrow_requests SET status='CANCELLED', cancelled_at=clock_timestamp() WHERE id=$1`,
    [s.req], { code: '23514', constraint: 'ck_req_columns' });                    // CANCELLED without cancelled_by
  s = await scenario(); await approve(s.req);
  await expectFail(`UPDATE borrow_requests SET status='CANCELLED',
                    cancelled_at = (SELECT decided_at FROM borrow_requests WHERE id=$1) - interval '1 hour',
                    cancelled_by=$2 WHERE id=$1`, [s.req, s.owner], { code: '23514', constraint: 'ck_req_time_order' });
}));

// ---------- DB-35 .. DB-42: loan immutability (final integrity improvement) ----------
// Each value is chosen so that, without trigger T-D, the UPDATE would otherwise be accepted or
// fail only on an FK/CHECK. The assertion on LD011 therefore proves the trigger, not a side effect.
const variants = [
  ['active loan', { borrowedAgo: 3, term: 14 }],
  ['returned loan', { borrowedAgo: 10, term: 14, returnedAgo: 2 }],
];
async function protectedField(name, makeUpdate) {
  for (const [label, opts] of variants) {
    await inTx(async () => {
      const s = await scenario({ loan: opts });
      const copy2 = await mkCopy(s.owner, s.book);
      const before = await one(`SELECT * FROM loans WHERE id=$1`, [s.loan]);
      const { sql, params } = makeUpdate({ ...s, copy2 });
      await expectFail(sql, params, { code: 'LD011' });
      assert.deepEqual(await one(`SELECT * FROM loans WHERE id=$1`, [s.loan]), before, `${name} on ${label} changed`);
    });
  }
}
test('DB-35 loans.request_id is immutable', () => protectedField('request_id',
  (s) => ({ sql: `UPDATE loans SET request_id=$2 WHERE id=$1`, params: [s.loan, randomUUID()] })));
test('DB-36 loans.copy_id is immutable', () => protectedField('copy_id',
  (s) => ({ sql: `UPDATE loans SET copy_id=$2 WHERE id=$1`, params: [s.loan, s.copy2] })));
test('DB-37 loans.borrower_id is immutable', () => protectedField('borrower_id',
  (s) => ({ sql: `UPDATE loans SET borrower_id=$2 WHERE id=$1`, params: [s.loan, s.other] })));
test('DB-38 loans.lender_id is immutable', () => protectedField('lender_id',
  (s) => ({ sql: `UPDATE loans SET lender_id=$2 WHERE id=$1`, params: [s.loan, s.other] })));
test('DB-39 loans.borrowed_at is immutable', () => protectedField('borrowed_at',
  (s) => ({ sql: `UPDATE loans SET borrowed_at = borrowed_at - interval '1 day' WHERE id=$1`, params: [s.loan] })));
test('DB-40 loans.due_at is immutable', () => protectedField('due_at',
  (s) => ({ sql: `UPDATE loans SET due_at = due_at + interval '1 day' WHERE id=$1`, params: [s.loan] })));
test('DB-41 loans.id is immutable', () => protectedField('id',
  (s) => ({ sql: `UPDATE loans SET id=$2 WHERE id=$1`, params: [s.loan, randomUUID()] })));

test('DB-42 returned_at: NULL -> value allowed once; then never changed', () => inTx(async () => {
  const s = await scenario({ loan: { borrowedAgo: 5, term: 14 } });
  await expectOk(`UPDATE loans SET returned_at = clock_timestamp() WHERE id=$1`, [s.loan]);        // first set: allowed
  await expectOk(`UPDATE loans SET returned_at = returned_at WHERE id=$1`, [s.loan]);              // no-op: allowed
  await expectFail(`UPDATE loans SET returned_at = returned_at + interval '1 hour' WHERE id=$1`, [s.loan], { code: 'LD008' });
  await expectFail(`UPDATE loans SET returned_at = NULL WHERE id=$1`, [s.loan], { code: 'LD008' });
}));

// ---------- DB-43 .. DB-45: commit-time request/loan pairing (T-G) ----------
test('DB-43 a loan whose request is still APPROVED cannot commit', () => inTx(async () => {
  const s = await scenario(); await approve(s.req);
  await mkLoan(s.req);                                        // loan inserted, request NOT flipped
  await expectFail(FINALISE, [], { code: 'LD012' });
}));

test('DB-44 a FULFILLED request without a loan cannot commit', () => inTx(async () => {
  await c.query('ALTER TABLE borrow_requests DISABLE TRIGGER trg_requests_before_update'); // bypass T-B to isolate T-G
  const s = await scenario(); await approve(s.req);
  await fulfil(s.req);
  await expectFail(FINALISE, [], { code: 'LD006' });
}));

test('DB-45 a complete handoff satisfies the commit-time check', () => inTx(async () => {
  await scenario({ loan: {} });
  await expectOk(FINALISE);
}));
