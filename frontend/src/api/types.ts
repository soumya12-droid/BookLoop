// Types mirror the backend DTOs (backend/src/repositories/*.ts, services/auth.ts). Dates are ISO strings.
export interface PageInfo { limit: number; offset: number; total: number }
export interface Envelope<T> { data: T; page?: PageInfo }

export type Role = 'MEMBER' | 'ADMIN';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  defaultPickupLocation: string | null;
  contactInfo: string | null;
  createdAt: string;
}

export interface AuthResult { user: User; token: string; tokenType: string; expiresIn: number }

export interface NamedRef { id: string; name: string }
export interface Person { id: string; displayName: string }

export interface Book {
  id: string;
  title: string;
  isbn: string | null;
  edition: string | null;
  publisher: string | null;
  publicationYear: number | null;
  description: string | null;
  createdAt: string;
  authors: NamedRef[];
  genres: NamedRef[];
  availableCopies: number;
  reviewCount: number;
  averageRating: number | null;
}

export type CopyCondition = 'NEW' | 'LIKE_NEW' | 'GOOD' | 'FAIR' | 'POOR';

export interface Copy {
  id: string;
  bookId: string;
  bookTitle: string;
  /** Anonymous visitors get the display name only (no member id, pickup place or notes). */
  owner: { id?: string; displayName: string };
  condition: CopyCondition;
  isListed: boolean;
  pickupLocation: string | null;
  notes: string | null;
  available: boolean;
  createdAt: string;
}

export interface Review {
  id: string;
  /** Present for signed-in callers only. */
  loanId?: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  reviewerName: string;
}

export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'FULFILLED';

export interface CopyRef { id: string; bookId: string; bookTitle: string }

export interface BorrowRequest {
  id: string;
  status: RequestStatus;
  message: string | null;
  createdAt: string;
  decidedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  copy: CopyRef;
  owner: Person;
  requester: Person;
  loanId: string | null;
  counterpartyContact: string | null;
}

export interface Loan {
  id: string;
  requestId: string;
  copy: CopyRef;
  borrower: Person;
  lender: Person;
  borrowedAt: string;
  dueAt: string;
  returnedAt: string | null;
  isOverdue: boolean;
  counterpartyContact: string | null;
}

export interface ReviewCreated { id: string; loanId: string; rating: number; comment: string | null }

export interface NewBookInput {
  title: string;
  isbn?: string | null;
  edition?: string | null;
  publisher?: string | null;
  publicationYear?: number | null;
  description?: string | null;
  authors?: string[];
  genreIds?: string[];
}

export interface NewCopyInput {
  condition?: CopyCondition;
  pickupLocation?: string | null;
  notes?: string | null;
}

export interface ProfilePatch {
  displayName?: string;
  defaultPickupLocation?: string | null;
  contactInfo?: string | null;
}
