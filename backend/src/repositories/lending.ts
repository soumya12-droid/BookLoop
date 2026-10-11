// Read-only views of requests and loans, shaped for the API, with contact-information gating (D-6):
// the other party's contact_info is returned ONLY while the request is APPROVED or the loan is
// active, and only to the two parties (and administrators). Otherwise it is null.
import type { Pool } from 'pg';
import type { Person } from './catalogue.ts';

export interface Viewer { id: string; isAdmin: boolean }

export interface RequestDto {
  id: string;
  status: string;
  message: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  copy: { id: string; bookId: string; bookTitle: string };
  owner: Person;
  requester: Person;
  loanId: string | null;
  /** Contact details of the OTHER party for the viewer, or null when not disclosable. */
  counterpartyContact: string | null;
}

export interface LoanDto {
  id: string;
  requestId: string;
  copy: { id: string; bookId: string; bookTitle: string };
  borrower: Person;
  lender: Person;
  borrowedAt: Date;
  dueAt: Date;
  returnedAt: Date | null;
  isOverdue: boolean;
  counterpartyContact: string | null;
}

interface RequestRow {
  id: string; status: string; message: string | null; created_at: Date; decided_at: Date | null;
  cancelled_at: Date | null; cancelled_by: string | null; requester_id: string; requester_name: string;
  requester_contact: string | null; copy_id: string; book_id: string; book_title: string;
  owner_id: string; owner_name: string; owner_contact: string | null;
  loan_id: string | null; loan_returned_at: Date | null;
}

const REQUEST_SELECT = `
  SELECT r.id, r.status, r.message, r.created_at, r.decided_at, r.cancelled_at, r.cancelled_by,
         r.requester_id, ru.display_name AS requester_name, ru.contact_info AS requester_contact,
         c.id AS copy_id, c.book_id, b.title AS book_title,
         c.owner_id, ou.display_name AS owner_name, ou.contact_info AS owner_contact,
         l.id AS loan_id, l.returned_at AS loan_returned_at
    FROM borrow_requests r
    JOIN copies c ON c.id = r.copy_id
    JOIN books  b ON b.id = c.book_id
    JOIN users ru ON ru.id = r.requester_id
    JOIN users ou ON ou.id = c.owner_id
    LEFT JOIN loans l ON l.request_id = r.id`;

function toRequest(r: RequestRow, v: Viewer): RequestDto {
  const disclosable = r.status === 'APPROVED' || (r.status === 'FULFILLED' && r.loan_returned_at === null);
  let contact: string | null = null;
  if (disclosable) {
    if (v.id === r.requester_id) contact = r.owner_contact;
    else if (v.id === r.owner_id) contact = r.requester_contact;
    else if (v.isAdmin) contact = r.owner_contact; // administrators coordinate overrides
  }
  return {
    id: r.id, status: r.status, message: r.message, createdAt: r.created_at, decidedAt: r.decided_at,
    cancelledAt: r.cancelled_at, cancelledBy: r.cancelled_by,
    copy: { id: r.copy_id, bookId: r.book_id, bookTitle: r.book_title },
    owner: { id: r.owner_id, displayName: r.owner_name },
    requester: { id: r.requester_id, displayName: r.requester_name },
    loanId: r.loan_id, counterpartyContact: contact,
  };
}

export type RequestRole = 'requester' | 'owner' | 'all';

export async function listRequests(
  pool: Pool, v: Viewer, role: RequestRole, status: string | undefined, limit: number, offset: number,
): Promise<{ items: RequestDto[]; total: number }> {
  const args: unknown[] = [];
  const where: string[] = [];
  const arg = (x: unknown) => { args.push(x); return `$${args.length}`; };
  if (role === 'requester') where.push(`r.requester_id = ${arg(v.id)}`);
  else if (role === 'owner') where.push(`c.owner_id = ${arg(v.id)}`);
  if (status) where.push(`r.status = ${arg(status)}`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM borrow_requests r JOIN copies c ON c.id = r.copy_id ${w}`, args);
  const lim = arg(limit); const off = arg(offset);
  const rows = await pool.query<RequestRow>(
    `${REQUEST_SELECT} ${w} ORDER BY r.created_at DESC, r.id LIMIT ${lim} OFFSET ${off}`, args);
  return { items: rows.rows.map((r) => toRequest(r, v)), total: total.rows[0]!.n };
}

/** Returns null when absent OR when the viewer is not a party (existence is concealed). */
export async function getRequest(pool: Pool, requestId: string, v: Viewer): Promise<RequestDto | null> {
  const r = await pool.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [requestId]);
  const row = r.rows[0];
  if (!row) return null;
  if (!v.isAdmin && v.id !== row.requester_id && v.id !== row.owner_id) return null;
  return toRequest(row, v);
}

interface LoanRow {
  id: string; request_id: string; borrowed_at: Date; due_at: Date; returned_at: Date | null;
  is_overdue: boolean; copy_id: string; book_id: string; book_title: string;
  borrower_id: string; borrower_name: string; borrower_contact: string | null;
  lender_id: string; lender_name: string; lender_contact: string | null;
}

const LOAN_SELECT = `
  SELECT l.id, l.request_id, l.borrowed_at, l.due_at, l.returned_at,
         (l.returned_at IS NULL AND l.due_at < now()) AS is_overdue,
         c.id AS copy_id, c.book_id, b.title AS book_title,
         l.borrower_id, bu.display_name AS borrower_name, bu.contact_info AS borrower_contact,
         l.lender_id, lu.display_name AS lender_name, lu.contact_info AS lender_contact
    FROM loans l
    JOIN copies c ON c.id = l.copy_id
    JOIN books  b ON b.id = c.book_id
    JOIN users bu ON bu.id = l.borrower_id
    JOIN users lu ON lu.id = l.lender_id`;

function toLoan(r: LoanRow, v: Viewer): LoanDto {
  const active = r.returned_at === null;
  let contact: string | null = null;
  if (active) {
    if (v.id === r.borrower_id) contact = r.lender_contact;
    else if (v.id === r.lender_id) contact = r.borrower_contact;
    else if (v.isAdmin) contact = r.lender_contact;
  }
  return {
    id: r.id, requestId: r.request_id,
    copy: { id: r.copy_id, bookId: r.book_id, bookTitle: r.book_title },
    borrower: { id: r.borrower_id, displayName: r.borrower_name },
    lender: { id: r.lender_id, displayName: r.lender_name },
    borrowedAt: r.borrowed_at, dueAt: r.due_at, returnedAt: r.returned_at,
    isOverdue: r.is_overdue, counterpartyContact: contact,
  };
}

export type LoanRole = 'borrower' | 'lender' | 'all';
export type LoanStatus = 'active' | 'returned' | 'overdue';

export async function listLoans(
  pool: Pool, v: Viewer, role: LoanRole, status: LoanStatus | undefined, limit: number, offset: number,
): Promise<{ items: LoanDto[]; total: number }> {
  const args: unknown[] = [];
  const where: string[] = [];
  const arg = (x: unknown) => { args.push(x); return `$${args.length}`; };
  if (role === 'borrower') where.push(`l.borrower_id = ${arg(v.id)}`);
  else if (role === 'lender') where.push(`l.lender_id = ${arg(v.id)}`);
  if (status === 'active') where.push(`l.returned_at IS NULL`);
  else if (status === 'returned') where.push(`l.returned_at IS NOT NULL`);
  else if (status === 'overdue') where.push(`l.returned_at IS NULL AND l.due_at < now()`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM loans l ${w}`, args);
  const lim = arg(limit); const off = arg(offset);
  const rows = await pool.query<LoanRow>(
    `${LOAN_SELECT} ${w} ORDER BY l.borrowed_at DESC, l.id LIMIT ${lim} OFFSET ${off}`, args);
  return { items: rows.rows.map((r) => toLoan(r, v)), total: total.rows[0]!.n };
}

export async function getLoan(pool: Pool, loanId: string, v: Viewer): Promise<LoanDto | null> {
  const r = await pool.query<LoanRow>(`${LOAN_SELECT} WHERE l.id = $1`, [loanId]);
  const row = r.rows[0];
  if (!row) return null;
  if (!v.isAdmin && v.id !== row.borrower_id && v.id !== row.lender_id) return null;
  return toLoan(row, v);
}
