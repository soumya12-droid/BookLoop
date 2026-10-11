// Read-only catalogue queries. Availability is always derived from the available_copies view.
import type { Pool } from 'pg';

export interface Person { id: string; displayName: string }

export interface BookDto {
  id: string; title: string; isbn: string | null; edition: string | null; publisher: string | null;
  publicationYear: number | null; description: string | null; createdAt: Date;
  authors: { id: string; name: string }[];
  genres: { id: string; name: string }[];
  availableCopies: number;
  reviewCount: number;
  averageRating: number | null;
}

export interface CopyDto {
  id: string; bookId: string; bookTitle: string; owner: Person;
  condition: string; isListed: boolean; pickupLocation: string | null; notes: string | null;
  available: boolean; createdAt: Date;
}

/** What an anonymous visitor may see of a copy: no member id, no pickup place, no free-text notes. */
export interface PublicCopyDto extends Omit<CopyDto, 'owner'> {
  owner: { displayName: string };
}

export const toPublicCopy = (c: CopyDto): PublicCopyDto => ({
  id: c.id, bookId: c.bookId, bookTitle: c.bookTitle,
  owner: { displayName: c.owner.displayName },
  condition: c.condition, isListed: c.isListed, pickupLocation: null, notes: null,
  available: c.available, createdAt: c.createdAt,
});

export interface ReviewDto {
  id: string; loanId: string; rating: number; comment: string | null; createdAt: Date; reviewerName: string;
}

/** Anonymous view of a review: the internal loan id is not disclosed. */
export type PublicReviewDto = Omit<ReviewDto, 'loanId'>;
export const toPublicReview = ({ loanId: _loanId, ...rest }: ReviewDto): PublicReviewDto => rest;

const BOOK_SELECT = `
  SELECT b.id, b.title, b.isbn, b.edition, b.publisher, b.publication_year, b.description, b.created_at,
    COALESCE((SELECT json_agg(json_build_object('id', a.id, 'name', a.name) ORDER BY ba.author_order)
                FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id), '[]'::json) AS authors,
    COALESCE((SELECT json_agg(json_build_object('id', g.id, 'name', g.name) ORDER BY g.name)
                FROM book_genres bg JOIN genres g ON g.id = bg.genre_id WHERE bg.book_id = b.id), '[]'::json) AS genres,
    (SELECT count(*)::int FROM available_copies ac WHERE ac.book_id = b.id) AS available_copies,
    (SELECT count(*)::int FROM reviews rv JOIN loans l ON l.id = rv.loan_id JOIN copies c ON c.id = l.copy_id
      WHERE c.book_id = b.id) AS review_count,
    (SELECT round(avg(rv.rating)::numeric, 2)::float FROM reviews rv JOIN loans l ON l.id = rv.loan_id
       JOIN copies c ON c.id = l.copy_id WHERE c.book_id = b.id) AS average_rating
  FROM books b`;

interface BookRow {
  id: string; title: string; isbn: string | null; edition: string | null; publisher: string | null;
  publication_year: number | null; description: string | null; created_at: Date;
  authors: { id: string; name: string }[]; genres: { id: string; name: string }[];
  available_copies: number; review_count: number; average_rating: number | null;
}

const toBook = (r: BookRow): BookDto => ({
  id: r.id, title: r.title, isbn: r.isbn, edition: r.edition, publisher: r.publisher,
  publicationYear: r.publication_year, description: r.description, createdAt: r.created_at,
  authors: r.authors, genres: r.genres, availableCopies: r.available_copies,
  reviewCount: r.review_count, averageRating: r.average_rating,
});

/** Escapes LIKE metacharacters so user input is always matched literally. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface BookSearch {
  q?: string;
  genreId?: string;
  availableOnly?: boolean;
  limit: number;
  offset: number;
}

export async function searchBooks(pool: Pool, s: BookSearch): Promise<{ items: BookDto[]; total: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  const arg = (v: unknown) => { args.push(v); return `$${args.length}`; };

  if (s.q) {
    const like = arg(escapeLike(s.q));
    const digits = s.q.replace(/[-\s]/g, '');
    const isbn = arg(/^97[89]\d{10}$/.test(digits) ? digits : null);
    where.push(`(b.title ILIKE '%' || ${like} || '%' OR b.isbn = ${isbn}
      OR EXISTS (SELECT 1 FROM book_authors ba JOIN authors a ON a.id = ba.author_id
                  WHERE ba.book_id = b.id AND a.name ILIKE '%' || ${like} || '%')
      OR EXISTS (SELECT 1 FROM book_genres bg JOIN genres g ON g.id = bg.genre_id
                  WHERE bg.book_id = b.id AND g.name ILIKE '%' || ${like} || '%'))`);
  }
  if (s.genreId) {
    where.push(`EXISTS (SELECT 1 FROM book_genres bg WHERE bg.book_id = b.id AND bg.genre_id = ${arg(s.genreId)})`);
  }
  if (s.availableOnly) {
    where.push(`EXISTS (SELECT 1 FROM available_copies ac WHERE ac.book_id = b.id)`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM books b ${w}`, args);
  const limit = arg(s.limit);
  const offset = arg(s.offset);
  const rows = await pool.query<BookRow>(
    `${BOOK_SELECT} ${w} ORDER BY b.title, b.id LIMIT ${limit} OFFSET ${offset}`, args);
  return { items: rows.rows.map(toBook), total: total.rows[0]!.n };
}

export async function getBook(pool: Pool, bookId: string): Promise<BookDto | null> {
  const r = await pool.query<BookRow>(`${BOOK_SELECT} WHERE b.id = $1`, [bookId]);
  return r.rows[0] ? toBook(r.rows[0]) : null;
}

export async function listGenres(pool: Pool): Promise<{ id: string; name: string }[]> {
  return (await pool.query<{ id: string; name: string }>(`SELECT id, name FROM genres ORDER BY name`)).rows;
}

interface CopyRow {
  id: string; book_id: string; book_title: string; owner_id: string; owner_name: string;
  copy_condition: string; is_listed: boolean; pickup_location: string | null; notes: string | null;
  available: boolean; created_at: Date;
}

const COPY_SELECT = `
  SELECT c.id, c.book_id, b.title AS book_title, u.id AS owner_id, u.display_name AS owner_name,
         c.copy_condition, c.is_listed,
         COALESCE(c.pickup_location, u.default_pickup_location) AS pickup_location, c.notes, c.created_at,
         EXISTS (SELECT 1 FROM available_copies a WHERE a.copy_id = c.id) AS available
    FROM copies c JOIN books b ON b.id = c.book_id JOIN users u ON u.id = c.owner_id`;

const toCopy = (r: CopyRow): CopyDto => ({
  id: r.id, bookId: r.book_id, bookTitle: r.book_title,
  owner: { id: r.owner_id, displayName: r.owner_name },
  condition: r.copy_condition, isListed: r.is_listed, pickupLocation: r.pickup_location, notes: r.notes,
  available: r.available, createdAt: r.created_at,
});

/**
 * Visibility: a copy is shown if it is listed by an active owner, or the viewer owns it, or the viewer
 * is an administrator. Anything else is indistinguishable from "does not exist".
 */
const VISIBLE = `((c.is_listed AND u.deactivated_at IS NULL) OR c.owner_id = $2::uuid OR $3::boolean)`;

export async function listCopiesForBook(pool: Pool, bookId: string, viewerId: string | null, isAdmin: boolean): Promise<CopyDto[]> {
  const r = await pool.query<CopyRow>(
    `${COPY_SELECT} WHERE c.book_id = $1 AND ${VISIBLE} ORDER BY c.created_at, c.id`, [bookId, viewerId, isAdmin]);
  return r.rows.map(toCopy);
}

export async function getCopy(pool: Pool, copyId: string, viewerId: string | null, isAdmin: boolean): Promise<CopyDto | null> {
  const r = await pool.query<CopyRow>(
    `${COPY_SELECT} WHERE c.id = $1 AND ${VISIBLE}`, [copyId, viewerId, isAdmin]);
  return r.rows[0] ? toCopy(r.rows[0]) : null;
}

export async function listOwnCopies(pool: Pool, ownerId: string): Promise<CopyDto[]> {
  const r = await pool.query<CopyRow>(
    `${COPY_SELECT} WHERE c.owner_id = $1 ORDER BY c.created_at DESC, c.id`, [ownerId]);
  return r.rows.map(toCopy);
}

export async function bookExists(pool: Pool, bookId: string): Promise<boolean> {
  return (await pool.query(`SELECT 1 FROM books WHERE id = $1`, [bookId])).rowCount === 1;
}

export async function listReviews(
  pool: Pool, bookId: string, limit: number, offset: number,
): Promise<{ items: ReviewDto[]; total: number }> {
  const total = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM reviews rv JOIN loans l ON l.id = rv.loan_id
       JOIN copies c ON c.id = l.copy_id WHERE c.book_id = $1`, [bookId]);
  const r = await pool.query<{
    id: string; loan_id: string; rating: number; comment: string | null; created_at: Date; reviewer_name: string;
  }>(
    `SELECT rv.id, rv.loan_id, rv.rating, rv.comment, rv.created_at, u.display_name AS reviewer_name
       FROM reviews rv JOIN loans l ON l.id = rv.loan_id JOIN copies c ON c.id = l.copy_id
       JOIN users u ON u.id = l.borrower_id
      WHERE c.book_id = $1 ORDER BY rv.created_at DESC, rv.id LIMIT $2 OFFSET $3`, [bookId, limit, offset]);
  return {
    total: total.rows[0]!.n,
    items: r.rows.map((x) => ({
      id: x.id, loanId: x.loan_id, rating: x.rating, comment: x.comment, createdAt: x.created_at,
      reviewerName: x.reviewer_name,
    })),
  };
}
