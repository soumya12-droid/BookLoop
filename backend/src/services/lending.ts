// Lending service functions (Phase 2). Explicit SQL; one transaction per operation.
//
// LOCK PROTOCOL (docs/PROPOSED_SCHEMA_V1.md section 2). Every lending write takes locks in ONE order:
//     users (deactivation only)  ->  copies  ->  borrow_requests  ->  loans
// and evaluates authorisation / status / availability AFTER the locks are held, on the locked rows.
// State changes are compare-and-set UPDATEs. Event timestamps use clock_timestamp(), never now().
//
// Each operation exists twice:
//   xxxTx(tx, ...)        runs inside a transaction the caller owns (used by tests and by wrappers)
//   lending.xxx(db, ...)  opens a transaction, retries once on deadlock/serialisation, translates errors
import type { Db, Tx, TxOptions } from '../db/pool.ts';
import { withTransaction } from '../db/pool.ts';
import { LendingError, conflict, forbidden, invalid, notFound, toLendingError } from './errors.ts';

export type Role = 'MEMBER' | 'ADMIN';
export interface RequestRow {
  id: string; copy_id: string; requester_id: string; status: string;
  message: string | null; created_at: Date; decided_at: Date | null;
  cancelled_at: Date | null; cancelled_by: string | null;
}
export interface LoanRow {
  id: string; request_id: string; copy_id: string; borrower_id: string; lender_id: string;
  borrowed_at: Date; due_at: Date; returned_at: Date | null;
}
export interface CopyRow { id: string; book_id: string; owner_id: string; is_listed: boolean; copy_condition: string }
export interface ReviewRow { id: string; loan_id: string; rating: number; comment: string | null }

/** Test-only fault-injection seam for the atomicity test. Not part of any public API. */
export interface HandoffHooks { afterLoanInsert?: () => Promise<void> | void }

export const stats = { deadlockRetries: 0 };

// ---------- shared helpers ----------
interface ActorRow { id: string; role: Role; active: boolean }

async function loadActor(tx: Tx, actorId: string): Promise<ActorRow> {
  const r = await tx.query<ActorRow>(
    `SELECT id, role, (deactivated_at IS NULL) AS active FROM users WHERE id = $1`, [actorId]);
  const a = r.rows[0];
  if (!a) throw new LendingError('UNAUTHENTICATED', 'Unknown user', 401);
  if (!a.active) throw new LendingError('ACCOUNT_DEACTIVATED', 'This account is deactivated', 403);
  return a; // role comes from the database, never from the caller
}

/**
 * Availability facts for a copy, plus whether one user is active, in ONE statement (one snapshot).
 * Called while the copy row is locked. Fewer round trips under the lock = shorter lock hold time.
 */
interface Facts { user_active: boolean | null; on_loan: boolean; reserved: boolean }
async function facts(tx: Tx, copyId: string, userId: string | null): Promise<Facts> {
  const r = await tx.query<Facts>(
    `SELECT (SELECT deactivated_at IS NULL FROM users WHERE id = $2)                         AS user_active,
            EXISTS (SELECT 1 FROM loans WHERE copy_id = $1 AND returned_at IS NULL)          AS on_loan,
            EXISTS (SELECT 1 FROM borrow_requests WHERE copy_id = $1 AND status = 'APPROVED') AS reserved`,
    [copyId, userId]);
  return r.rows[0]!;
}

async function lockCopy(tx: Tx, copyId: string): Promise<CopyRow> {
  const r = await tx.query<CopyRow>(
    `SELECT id, book_id, owner_id, is_listed, copy_condition FROM copies WHERE id = $1 FOR UPDATE`, [copyId]);
  const c = r.rows[0];
  if (!c) throw notFound('COPY_NOT_FOUND', 'Copy');
  return c;
}

/** copy -> request. The copy_id of a request is immutable (trigger T-B), so the lookup cannot go stale. */
async function lockCopyAndRequest(tx: Tx, requestId: string): Promise<{ copy: CopyRow; req: RequestRow }> {
  // One statement locks the copy and returns the locked (latest) row version.
  const l = await tx.query<CopyRow>(
    `SELECT c.id, c.book_id, c.owner_id, c.is_listed, c.copy_condition
       FROM copies c JOIN borrow_requests r ON r.copy_id = c.id WHERE r.id = $1 FOR UPDATE OF c`,
    [requestId]);
  const copy = l.rows[0];
  if (!copy) throw notFound('REQUEST_NOT_FOUND', 'Request');
  const r = await tx.query<RequestRow>(`SELECT * FROM borrow_requests WHERE id = $1 FOR UPDATE`, [requestId]);
  if (!r.rows[0]) throw notFound('REQUEST_NOT_FOUND', 'Request');
  return { copy, req: r.rows[0] };
}

/** copy -> loan. */
async function lockCopyAndLoan(tx: Tx, loanId: string): Promise<{ copy: CopyRow; loan: LoanRow }> {
  const l = await tx.query<CopyRow>(
    `SELECT c.id, c.book_id, c.owner_id, c.is_listed, c.copy_condition
       FROM copies c JOIN loans l ON l.copy_id = c.id WHERE l.id = $1 FOR UPDATE OF c`, [loanId]);
  const copy = l.rows[0];
  if (!copy) throw notFound('LOAN_NOT_FOUND', 'Loan');
  const r = await tx.query<LoanRow>(`SELECT * FROM loans WHERE id = $1 FOR UPDATE`, [loanId]);
  if (!r.rows[0]) throw notFound('LOAN_NOT_FOUND', 'Loan');
  return { copy, loan: r.rows[0] };
}

// ---------- listings ----------
export async function createCopyTx(
  tx: Tx, actorId: string,
  input: { bookId: string; condition?: string; pickupLocation?: string | null; notes?: string | null },
): Promise<CopyRow> {
  await loadActor(tx, actorId); // deactivated members cannot create listings
  const book = await tx.query(`SELECT 1 FROM books WHERE id = $1`, [input.bookId]);
  if (book.rowCount === 0) throw notFound('BOOK_NOT_FOUND', 'Book');
  const r = await tx.query<CopyRow>(
    `INSERT INTO copies (book_id, owner_id, copy_condition, pickup_location, notes)
     VALUES ($1, $2, COALESCE($3, 'GOOD'), $4, $5)
     RETURNING id, book_id, owner_id, is_listed, copy_condition`,
    [input.bookId, actorId, input.condition ?? null, input.pickupLocation ?? null, input.notes ?? null]);
  return r.rows[0]!;
}

export async function setListingTx(tx: Tx, actorId: string, copyId: string, listed: boolean): Promise<CopyRow> {
  const actor = await loadActor(tx, actorId);
  const copy = await lockCopy(tx, copyId);
  if (copy.owner_id !== actor.id) {
    throw actor.role === 'ADMIN' ? forbidden('Only the owner can change a listing') : notFound('COPY_NOT_FOUND', 'Copy');
  }
  if (!listed) {
    const f = await facts(tx, copy.id, null);
    if (f.on_loan) throw conflict('COPY_ON_LOAN', 'A copy that is on loan cannot be unlisted');
    if (f.reserved) {
      throw conflict('COPY_RESERVED', 'A copy with an approved reservation cannot be unlisted; cancel the reservation first');
    }
  }
  const r = await tx.query<CopyRow>(
    `UPDATE copies SET is_listed = $2, updated_at = clock_timestamp() WHERE id = $1
     RETURNING id, book_id, owner_id, is_listed, copy_condition`, [copy.id, listed]);
  return r.rows[0]!;
}

// ---------- requests ----------
export async function createRequestTx(
  tx: Tx, actorId: string, copyId: string, message?: string | null,
): Promise<RequestRow> {
  if (message != null && message.length > 500) throw invalid('MESSAGE_TOO_LONG', 'Message is limited to 500 characters');
  const actor = await loadActor(tx, actorId);
  const copy = await lockCopy(tx, copyId);

  if (copy.owner_id === actor.id) throw invalid('SELF_REQUEST', 'You cannot request your own copy');
  const unavailable = (reason: string) =>
    conflict('COPY_UNAVAILABLE', 'This copy is not currently available', { reason });
  if (!copy.is_listed) throw unavailable('UNLISTED');
  const f = await facts(tx, copy.id, copy.owner_id);
  if (f.user_active !== true) throw unavailable('OWNER_DEACTIVATED');
  if (f.on_loan) throw unavailable('ON_LOAN');
  if (f.reserved) throw unavailable('RESERVED');

  // D-7: a member with an overdue loan cannot create new requests (derived, nothing stored).
  // One statement returns the overdue loans (if any) and whether an open request already exists.
  const chk = await tx.query<{ id: string | null; due_at: Date | null; lender_id: string | null; dup: boolean }>(
    `SELECT l.id, l.due_at, l.lender_id,
            EXISTS (SELECT 1 FROM borrow_requests
                    WHERE copy_id = $2 AND requester_id = $1 AND status IN ('PENDING','APPROVED')) AS dup
       FROM (SELECT 1) AS one
       LEFT JOIN loans l ON l.borrower_id = $1 AND l.returned_at IS NULL AND l.due_at < now()
      ORDER BY l.due_at`, [actor.id, copy.id]);
  const overdue = chk.rows.filter((r) => r.id !== null);
  if (overdue.length > 0) {
    throw conflict('OVERDUE_LOANS_BLOCK',
      'You have overdue loans. Return them (ask the lender to record the return) before requesting more books.',
      { loans: overdue.map((l) => ({ loanId: l.id, dueAt: l.due_at, lenderId: l.lender_id })) });
  }
  if (chk.rows[0]?.dup) throw conflict('DUPLICATE_OPEN_REQUEST', 'You already have an open request for this copy');

  const r = await tx.query<RequestRow>(
    `INSERT INTO borrow_requests (copy_id, requester_id, message) VALUES ($1, $2, $3) RETURNING *`,
    [copy.id, actor.id, message ?? null]);
  return r.rows[0]!;
}

/** Non-parties get 404 (existence is not leaked); parties without the right get 403. */
function denyUnlessParty(actor: ActorRow, copy: CopyRow, req: RequestRow, message: string): never {
  const party = actor.role === 'ADMIN' || actor.id === copy.owner_id || actor.id === req.requester_id;
  if (!party) throw notFound('REQUEST_NOT_FOUND', 'Request');
  throw forbidden(message);
}

export async function approveRequestTx(tx: Tx, actorId: string, requestId: string): Promise<RequestRow> {
  const actor = await loadActor(tx, actorId);
  const { copy, req } = await lockCopyAndRequest(tx, requestId);

  if (actor.id !== copy.owner_id) denyUnlessParty(actor, copy, req, 'Only the owner can approve a request');
  if (req.status !== 'PENDING') throw conflict('INVALID_STATE', `Request is ${req.status}, not PENDING`);
  if (!copy.is_listed) throw conflict('COPY_UNLISTED', 'This copy is no longer listed');
  const f = await facts(tx, copy.id, req.requester_id);
  if (f.user_active !== true) throw conflict('REQUESTER_DEACTIVATED', 'The requester is deactivated');
  if (f.on_loan) throw conflict('COPY_ON_LOAN', 'This copy is currently on loan');
  if (f.reserved) throw conflict('COPY_RESERVED', 'This copy already has an approved reservation');

  const r = await tx.query<RequestRow>(
    `UPDATE borrow_requests SET status = 'APPROVED', decided_at = clock_timestamp()
     WHERE id = $1 AND status = 'PENDING' RETURNING *`, [req.id]);
  if (r.rowCount === 0) throw conflict('INVALID_STATE', 'Request is no longer PENDING');
  return r.rows[0]!;
}

export async function rejectRequestTx(tx: Tx, actorId: string, requestId: string): Promise<RequestRow> {
  const actor = await loadActor(tx, actorId);
  const { copy, req } = await lockCopyAndRequest(tx, requestId);

  if (actor.id !== copy.owner_id) denyUnlessParty(actor, copy, req, 'Only the owner can reject a request');
  if (req.status !== 'PENDING') throw conflict('INVALID_STATE', `Request is ${req.status}, not PENDING`);

  const r = await tx.query<RequestRow>(
    `UPDATE borrow_requests SET status = 'REJECTED', decided_at = clock_timestamp()
     WHERE id = $1 AND status = 'PENDING' RETURNING *`, [req.id]);
  if (r.rowCount === 0) throw conflict('INVALID_STATE', 'Request is no longer PENDING');
  return r.rows[0]!;
}

/**
 * Cancel / release. Requester: PENDING or APPROVED. Owner: APPROVED only (no-show; PENDING is "reject").
 * Admin: either. The single UPDATE releases the reservation atomically: the unique-index slot, the
 * availability view and the open-request slot all change at this one commit.
 */
export async function cancelRequestTx(tx: Tx, actorId: string, requestId: string): Promise<RequestRow> {
  const actor = await loadActor(tx, actorId);
  const { copy, req } = await lockCopyAndRequest(tx, requestId);

  const isRequester = actor.id === req.requester_id;
  const isOwner = actor.id === copy.owner_id;
  const isAdmin = actor.role === 'ADMIN';
  if (!isRequester && !isOwner && !isAdmin) throw notFound('REQUEST_NOT_FOUND', 'Request');
  if (req.status !== 'PENDING' && req.status !== 'APPROVED') {
    throw conflict('INVALID_STATE', `Request is ${req.status} and cannot be cancelled`);
  }
  const allowed = isAdmin || (isRequester) || (isOwner && req.status === 'APPROVED');
  if (!allowed) throw forbidden('The owner rejects pending requests; only approved ones can be cancelled');

  const r = await tx.query<RequestRow>(
    `UPDATE borrow_requests
        SET status = 'CANCELLED', cancelled_at = clock_timestamp(), cancelled_by = $2
      WHERE id = $1 AND status IN ('PENDING','APPROVED') RETURNING *`, [req.id, actor.id]);
  if (r.rowCount === 0) throw conflict('INVALID_STATE', 'Request can no longer be cancelled');
  return r.rows[0]!;
}

// ---------- handoff / return ----------
/** Due at the end of the day (Asia/Kolkata) that is `days` days from today. */
const DUE_AT_SQL = `((((now() AT TIME ZONE 'Asia/Kolkata')::date + ($5::int + 1))::timestamp) AT TIME ZONE 'Asia/Kolkata')`;

export async function handoffTx(
  tx: Tx, actorId: string, requestId: string, days = 14, hooks?: HandoffHooks,
): Promise<LoanRow> {
  if (!Number.isInteger(days) || days < 1 || days > 60) {
    throw invalid('INVALID_LOAN_PERIOD', 'The loan period must be a whole number of days from 1 to 60');
  }
  const actor = await loadActor(tx, actorId);
  const { copy, req } = await lockCopyAndRequest(tx, requestId);

  const isOwner = actor.id === copy.owner_id;
  if (!isOwner && actor.role !== 'ADMIN') denyUnlessParty(actor, copy, req, 'Only the owner can record a handoff');
  if (req.status !== 'APPROVED') {
    throw conflict(req.status === 'FULFILLED' ? 'ALREADY_FULFILLED' : 'INVALID_STATE',
      `Request is ${req.status}, not APPROVED`);
  }
  const f = await facts(tx, copy.id, req.requester_id);
  if (f.user_active !== true) throw conflict('BORROWER_DEACTIVATED', 'The borrower is deactivated');
  if (f.on_loan) throw conflict('COPY_ON_LOAN', 'This copy is currently on loan');

  // Loan first (T-C requires the request to be APPROVED), then flip the request (T-B requires a loan).
  const loan = await tx.query<LoanRow>(
    `INSERT INTO loans (request_id, copy_id, borrower_id, lender_id, due_at)
     VALUES ($1, $2, $3, $4, ${DUE_AT_SQL}) RETURNING *`,
    [req.id, copy.id, req.requester_id, copy.owner_id, days]);
  await hooks?.afterLoanInsert?.();

  const upd = await tx.query(
    `UPDATE borrow_requests SET status = 'FULFILLED' WHERE id = $1 AND status = 'APPROVED'`, [req.id]);
  if (upd.rowCount === 0) throw conflict('INVALID_STATE', 'Request is no longer APPROVED');
  return loan.rows[0]!;
}

export async function returnLoanTx(tx: Tx, actorId: string, loanId: string): Promise<LoanRow> {
  const actor = await loadActor(tx, actorId);
  const { copy, loan } = await lockCopyAndLoan(tx, loanId);

  if (copy.owner_id !== actor.id && actor.role !== 'ADMIN') {
    const party = actor.id === loan.borrower_id;
    throw party ? forbidden('Only the lender can record a return') : notFound('LOAN_NOT_FOUND', 'Loan');
  }
  if (loan.returned_at !== null) throw conflict('ALREADY_RETURNED', 'This loan has already been returned');

  const r = await tx.query<LoanRow>(
    `UPDATE loans SET returned_at = clock_timestamp() WHERE id = $1 AND returned_at IS NULL RETURNING *`, [loan.id]);
  if (r.rowCount === 0) throw conflict('ALREADY_RETURNED', 'This loan has already been returned');
  return r.rows[0]!;
}

// ---------- reviews ----------
export async function createReviewTx(
  tx: Tx, actorId: string, loanId: string, rating: number, comment?: string | null,
): Promise<ReviewRow> {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw invalid('INVALID_RATING', 'Rating must be 1 to 5');
  if (comment != null && comment.length > 2000) throw invalid('COMMENT_TOO_LONG', 'Comment is limited to 2000 characters');
  const actor = await loadActor(tx, actorId);

  const l = await tx.query<LoanRow>(`SELECT * FROM loans WHERE id = $1`, [loanId]);
  const loan = l.rows[0];
  if (!loan) throw notFound('LOAN_NOT_FOUND', 'Loan');
  if (actor.id !== loan.borrower_id) {
    throw actor.id === loan.lender_id || actor.role === 'ADMIN'
      ? forbidden('Only the borrower can review this loan')
      : notFound('LOAN_NOT_FOUND', 'Loan');
  }
  if (loan.returned_at === null) throw conflict('LOAN_NOT_RETURNED', 'Only returned loans can be reviewed');

  const r = await tx.query<ReviewRow>(
    `INSERT INTO reviews (loan_id, rating, comment) VALUES ($1, $2, $3) RETURNING id, loan_id, rating, comment`,
    [loan.id, rating, comment ?? null]);
  return r.rows[0]!;
}

// ---------- administration ----------
/**
 * Lock order here is users -> copies (ascending id) -> requests. Active loans are untouched; the
 * requester's own PENDING/APPROVED requests are cancelled (cancelled_by = the admin).
 */
export async function deactivateUserTx(
  tx: Tx, adminId: string, targetId: string,
): Promise<{ userId: string; cancelledRequests: number }> {
  const admin = await loadActor(tx, adminId);
  if (admin.role !== 'ADMIN') throw forbidden('Administrator only');
  if (adminId === targetId) throw invalid('SELF_DEACTIVATION', 'Administrators cannot deactivate themselves');

  const u = await tx.query(
    `UPDATE users SET deactivated_at = clock_timestamp() WHERE id = $1 AND deactivated_at IS NULL RETURNING id`,
    [targetId]);
  if (u.rowCount === 0) {
    const exists = await tx.query(`SELECT 1 FROM users WHERE id = $1`, [targetId]);
    throw exists.rowCount === 0 ? notFound('USER_NOT_FOUND', 'User') : conflict('ALREADY_DEACTIVATED', 'User is already deactivated');
  }

  const open = await tx.query<{ id: string; copy_id: string }>(
    `SELECT id, copy_id FROM borrow_requests
     WHERE requester_id = $1 AND status IN ('PENDING','APPROVED') ORDER BY copy_id, id`, [targetId]);
  let cancelled = 0;
  for (const row of open.rows) {
    await lockCopy(tx, row.copy_id); // copy before request, ascending copy id
    const r = await tx.query(
      `UPDATE borrow_requests
          SET status = 'CANCELLED', cancelled_at = clock_timestamp(), cancelled_by = $2
        WHERE id = $1 AND status IN ('PENDING','APPROVED')`, [row.id, adminId]);
    cancelled += r.rowCount ?? 0; // a concurrent change may already have resolved it (compare-and-set)
  }
  return { userId: targetId, cancelledRequests: cancelled };
}

// ---------- public wrappers: one transaction each, retry once on deadlock ----------
async function run<T>(db: Db, fn: (tx: Tx) => Promise<T>, opts?: TxOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTransaction(db, fn, opts);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if ((code === '40P01' || code === '40001') && attempt < 2) {
        stats.deadlockRetries += 1;
        continue;
      }
      throw toLendingError(err);
    }
  }
}

export const lending = {
  createCopy: (db: Db, actorId: string, input: Parameters<typeof createCopyTx>[2], o?: TxOptions) =>
    run(db, (tx) => createCopyTx(tx, actorId, input), o),
  setListing: (db: Db, actorId: string, copyId: string, listed: boolean, o?: TxOptions) =>
    run(db, (tx) => setListingTx(tx, actorId, copyId, listed), o),
  createRequest: (db: Db, actorId: string, copyId: string, message?: string | null, o?: TxOptions) =>
    run(db, (tx) => createRequestTx(tx, actorId, copyId, message), o),
  approveRequest: (db: Db, actorId: string, requestId: string, o?: TxOptions) =>
    run(db, (tx) => approveRequestTx(tx, actorId, requestId), o),
  rejectRequest: (db: Db, actorId: string, requestId: string, o?: TxOptions) =>
    run(db, (tx) => rejectRequestTx(tx, actorId, requestId), o),
  cancelRequest: (db: Db, actorId: string, requestId: string, o?: TxOptions) =>
    run(db, (tx) => cancelRequestTx(tx, actorId, requestId), o),
  handoff: (db: Db, actorId: string, requestId: string, days = 14, o?: TxOptions & { hooks?: HandoffHooks }) =>
    run(db, (tx) => handoffTx(tx, actorId, requestId, days, o?.hooks), o),
  returnLoan: (db: Db, actorId: string, loanId: string, o?: TxOptions) =>
    run(db, (tx) => returnLoanTx(tx, actorId, loanId), o),
  createReview: (db: Db, actorId: string, loanId: string, rating: number, comment?: string | null, o?: TxOptions) =>
    run(db, (tx) => createReviewTx(tx, actorId, loanId, rating, comment), o),
  deactivateUser: (db: Db, adminId: string, targetId: string, o?: TxOptions) =>
    run(db, (tx) => deactivateUserTx(tx, adminId, targetId), o),
};
