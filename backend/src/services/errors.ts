/** A business-rule failure with a stable machine code and an HTTP status for the future API layer. */
export class LendingError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'LendingError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

export const notFound = (code: string, what: string) => new LendingError(code, `${what} not found`, 404);
export const forbidden = (message = 'You are not allowed to do that') => new LendingError('FORBIDDEN', message, 403);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new LendingError(code, message, 409, details);
export const invalid = (code: string, message: string) => new LendingError(code, message, 422);

interface PgLikeError {
  code?: string;
  constraint?: string;
  message?: string;
}

const UNIQUE_BY_CONSTRAINT: Record<string, [string, string]> = {
  uq_req_one_approved_per_copy: ['COPY_RESERVED', 'This copy already has an approved reservation'],
  uq_req_one_open_per_member_copy: ['DUPLICATE_OPEN_REQUEST', 'You already have an open request for this copy'],
  uq_loans_one_active_per_copy: ['COPY_ON_LOAN', 'This copy is currently on loan'],
  uq_loans_request: ['ALREADY_FULFILLED', 'This request has already been handed off'],
  uq_reviews_loan: ['ALREADY_REVIEWED', 'This loan has already been reviewed'],
  uq_users_email: ['EMAIL_TAKEN', 'That email address is already registered'],
};

const TRIGGER_CODES: Record<string, [string, string, number]> = {
  LD001: ['INVALID_INITIAL_STATE', 'A request must start as PENDING', 422],
  LD002: ['SELF_REQUEST', 'You cannot request your own copy', 422],
  LD003: ['IMMUTABLE_REQUEST', 'Request identity cannot be changed', 422],
  LD004: ['INVALID_TRANSITION', 'That status change is not allowed', 409],
  LD005: ['COPY_ON_LOAN', 'This copy is currently on loan', 409],
  LD006: ['NO_LOAN_FOR_REQUEST', 'A fulfilled request must have a loan', 409],
  LD007: ['REQUEST_NOT_APPROVED', 'A loan requires an approved request', 409],
  LD008: ['ALREADY_RETURNED', 'This loan has already been returned', 409],
  LD009: ['OWNERSHIP_IMMUTABLE', 'Copy ownership cannot be changed', 422],
  LD010: ['LOAN_NOT_RETURNED', 'Only returned loans can be reviewed', 409],
  LD011: ['LOAN_IMMUTABLE', 'A loan cannot be altered after creation', 422],
  LD012: ['REQUEST_LOAN_MISMATCH', 'Request and loan are out of step', 409],
};

/** Translate a database error into a LendingError. Unknown errors are returned untouched (=> 500). */
export function toLendingError(err: unknown): unknown {
  if (err instanceof LendingError) return err;
  const e = err as PgLikeError;
  if (!e || typeof e.code !== 'string') return err;

  if (e.code === '23505') {
    const hit = e.constraint ? UNIQUE_BY_CONSTRAINT[e.constraint] : undefined;
    return hit ? conflict(hit[0], hit[1]) : conflict('CONFLICT', 'That conflicts with existing data');
  }
  if (e.code === '23001') return conflict('IN_USE', 'This record is referenced by other data');
  if (e.code === '23503') return invalid('INVALID_REFERENCE', 'A referenced record does not exist or does not match');
  if (e.code === '23514') return invalid('CONSTRAINT_VIOLATION', 'A value is outside the allowed range');
  if (e.code === '55P03') return conflict('RESOURCE_BUSY', 'The record is busy; please retry');
  if (e.code === '40P01' || e.code === '40001') return conflict('RETRY', 'Please retry the operation');
  const trig = TRIGGER_CODES[e.code];
  if (trig) return new LendingError(trig[0], trig[1], trig[2]);
  return err;
}
