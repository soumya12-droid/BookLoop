// Typed wrappers around the BookLoop API. Names and parameters follow docs/API.md exactly.
import { api } from './client';
import type {
  AuthResult, Book, BorrowRequest, Copy, CopyCondition, Loan, NamedRef, NewBookInput, NewCopyInput,
  PageInfo, ProfilePatch, RequestStatus, Review, ReviewCreated, User,
} from './types';

export interface Paged<T> { items: T[]; page: PageInfo }

async function paged<T>(
  path: string, query: Record<string, string | number | boolean | undefined>, signal?: AbortSignal, publicRead = false,
): Promise<Paged<T>> {
  const r = await api<T[]>(path, { query, signal, public: publicRead });
  return { items: r.data, page: r.page ?? { limit: r.data.length, offset: 0, total: r.data.length } };
}

// ---- authentication / profile ----
export const register = (b: { email: string; password: string; displayName: string; contactInfo?: string | null; defaultPickupLocation?: string | null }) =>
  api<AuthResult>('/api/auth/register', { method: 'POST', body: b, auth: false }).then((r) => r.data);

export const login = (b: { email: string; password: string }) =>
  api<AuthResult>('/api/auth/login', { method: 'POST', body: b, auth: false }).then((r) => r.data);

export const me = (signal?: AbortSignal) => api<User>('/api/auth/me', { signal }).then((r) => r.data);
export const updateProfile = (patch: ProfilePatch) =>
  api<User>('/api/users/me', { method: 'PATCH', body: patch }).then((r) => r.data);

// ---- catalogue ----
export const listGenres = (signal?: AbortSignal) => api<NamedRef[]>('/api/genres', { signal, public: true }).then((r) => r.data);

export interface BookQuery { q?: string; genreId?: string; availableOnly?: boolean; limit?: number; offset?: number }
export const listBooks = (q: BookQuery, signal?: AbortSignal) =>
  paged<Book>('/api/books', { q: q.q, genreId: q.genreId, availableOnly: q.availableOnly ? true : undefined, limit: q.limit, offset: q.offset }, signal, true);

export const getBook = (id: string, signal?: AbortSignal) => api<Book>(`/api/books/${id}`, { signal, public: true }).then((r) => r.data);
export const createBook = (b: NewBookInput) => api<Book>('/api/books', { method: 'POST', body: b }).then((r) => r.data);

export const listCopies = (bookId: string, signal?: AbortSignal) =>
  api<Copy[]>(`/api/books/${bookId}/copies`, { signal, public: true }).then((r) => r.data);
export const createCopy = (bookId: string, b: NewCopyInput) =>
  api<Copy>(`/api/books/${bookId}/copies`, { method: 'POST', body: b }).then((r) => r.data);
export const setCopyListed = (copyId: string, isListed: boolean) =>
  api<Copy>(`/api/copies/${copyId}`, { method: 'PATCH', body: { isListed } }).then((r) => r.data);
export const myCopies = (signal?: AbortSignal) => api<Copy[]>('/api/users/me/copies', { signal }).then((r) => r.data);

export const listReviews = (bookId: string, limit: number, offset: number, signal?: AbortSignal) =>
  paged<Review>(`/api/books/${bookId}/reviews`, { limit, offset }, signal, true);

// ---- requests ----
export const requestCopy = (copyId: string, message?: string | null) =>
  api<BorrowRequest>(`/api/copies/${copyId}/requests`, { method: 'POST', body: message ? { message } : {} }).then((r) => r.data);

export const listRequests = (
  q: { role: 'requester' | 'owner'; status?: RequestStatus; limit?: number; offset?: number }, signal?: AbortSignal,
) => paged<BorrowRequest>('/api/requests', q, signal);

export type RequestAction = 'approve' | 'reject' | 'cancel';
export const actOnRequest = (id: string, action: RequestAction) =>
  api<BorrowRequest>(`/api/requests/${id}/${action}`, { method: 'POST' }).then((r) => r.data);
export const handoff = (id: string, days: number) =>
  api<Loan>(`/api/requests/${id}/handoff`, { method: 'POST', body: { days } }).then((r) => r.data);

// ---- loans / reviews ----
export const listLoans = (
  q: { role: 'borrower' | 'lender'; status?: 'active' | 'returned' | 'overdue'; limit?: number; offset?: number }, signal?: AbortSignal,
) => paged<Loan>('/api/loans', q, signal);
export const returnLoan = (id: string) => api<Loan>(`/api/loans/${id}/return`, { method: 'POST' }).then((r) => r.data);
export const reviewLoan = (id: string, rating: number, comment?: string | null) =>
  api<ReviewCreated>(`/api/loans/${id}/review`, { method: 'POST', body: { rating, ...(comment ? { comment } : {}) } }).then((r) => r.data);

export const CONDITIONS: { value: CopyCondition; label: string }[] = [
  { value: 'NEW', label: 'New' },
  { value: 'LIKE_NEW', label: 'Like new' },
  { value: 'GOOD', label: 'Good condition' },
  { value: 'FAIR', label: 'Fair' },
  { value: 'POOR', label: 'Well loved' },
];
