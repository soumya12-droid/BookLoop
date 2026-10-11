// Turns API errors into short, kind, user-facing sentences. Never shows raw server detail.
import { ApiError } from '../api/client';

const BY_CODE: Record<string, string> = {
  COPY_UNAVAILABLE: 'This copy is not available right now. It may be on loan or reserved for someone else.',
  DUPLICATE_OPEN_REQUEST: 'You already have an open request for this copy.',
  SELF_REQUEST: 'This is your own copy, so there is nobody to borrow it from.',
  OVERDUE_LOANS_BLOCK: 'You have an overdue loan. Please return it (ask the lender to record the return) before borrowing again.',
  INVALID_STATE: 'This request has already changed. Refresh to see its latest state.',
  COPY_RESERVED: 'This copy already has an approved reservation.',
  COPY_ON_LOAN: 'This copy is currently on loan.',
  ALREADY_RETURNED: 'This loan has already been marked as returned.',
  ALREADY_FULFILLED: 'This request has already been handed over.',
  ALREADY_REVIEWED: 'You have already reviewed this loan.',
  LOAN_NOT_RETURNED: 'You can review a book once it has been returned.',
  ISBN_EXISTS: 'A book with this ISBN is already in the catalogue. Search for it and add your copy instead.',
  EMAIL_TAKEN: 'That email address is already registered. Try signing in instead.',
  INVALID_CREDENTIALS: 'That email and password do not match. Please try again.',
  RATE_LIMITED: 'Too many attempts. Please wait a few minutes and try again.',
  RESOURCE_BUSY: 'BookLoop is busy with this copy at the moment. Please try again in a few seconds.',
  RETRY: 'BookLoop is busy at the moment. Please try again in a few seconds.',
  ACCOUNT_DEACTIVATED: 'This account has been deactivated.',
  UNAUTHENTICATED: 'Your session has ended. Please sign in again.',
  UNSUPPORTED_MEDIA_TYPE: 'The request could not be processed.',
};

export function friendlyMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err instanceof ApiError) {
    if (err.code === 'NETWORK') return err.message;
    if (err.status >= 500) return 'Something went wrong on our side. Please try again in a moment.';
    return BY_CODE[err.code] ?? (err.status === 400 || err.status === 422 ? err.message : fallback);
  }
  return fallback;
}

export interface FieldIssue { path: string; message: string }

/** Field-level problems from a 400 VALIDATION_ERROR (zod issues), keyed by field name. */
export function fieldErrors(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (err instanceof ApiError && err.code === 'VALIDATION_ERROR' && Array.isArray(err.details)) {
    for (const d of err.details as FieldIssue[]) {
      if (d && typeof d.path === 'string' && typeof d.message === 'string' && !(d.path in out)) out[d.path] = d.message;
    }
  }
  return out;
}
