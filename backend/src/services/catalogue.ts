// Catalogue writes: creating a title with its authors and genres in one transaction.
import type { Pool } from 'pg';
import { withTransaction } from '../db/pool.ts';
import { LendingError, invalid, toLendingError } from './errors.ts';

export interface NewBook {
  title: string;
  isbn?: string | null;           // already normalised ISBN-13 digits
  edition?: string | null;
  publisher?: string | null;
  publicationYear?: number | null;
  description?: string | null;
  authors?: string[];             // author display names, in order
  genreIds?: string[];            // must exist in the controlled genre list
}

export async function createBook(pool: Pool, input: NewBook, lockTimeoutMs?: number): Promise<string> {
  try {
    return await withTransaction(pool, async (tx) => {
      const genreIds = [...new Set(input.genreIds ?? [])];
      if (genreIds.length > 0) {
        const g = await tx.query(`SELECT count(*)::int AS n FROM genres WHERE id = ANY($1::uuid[])`, [genreIds]);
        if (g.rows[0].n !== genreIds.length) throw invalid('UNKNOWN_GENRE', 'One or more genres do not exist');
      }

      const b = await tx.query<{ id: string }>(
        `INSERT INTO books (title, isbn, edition, publisher, publication_year, description)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [input.title.trim(), input.isbn ?? null, input.edition ?? null, input.publisher ?? null,
         input.publicationYear ?? null, input.description ?? null]);
      const bookId = b.rows[0]!.id;

      // Authors are unique case-insensitively (uq_authors_name); reuse an existing row if present.
      let order = 1;
      const seen = new Set<string>();
      for (const raw of input.authors ?? []) {
        const name = raw.trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        await tx.query(`INSERT INTO authors (name) VALUES ($1) ON CONFLICT (lower(name)) DO NOTHING`, [name]);
        const a = await tx.query<{ id: string }>(`SELECT id FROM authors WHERE lower(name) = lower($1)`, [name]);
        await tx.query(
          `INSERT INTO book_authors (book_id, author_id, author_order) VALUES ($1, $2, $3)`,
          [bookId, a.rows[0]!.id, order++]);
      }
      for (const gid of genreIds) {
        await tx.query(`INSERT INTO book_genres (book_id, genre_id) VALUES ($1, $2)`, [bookId, gid]);
      }
      return bookId;
    }, lockTimeoutMs ? { lockTimeoutMs } : undefined);
  } catch (e) {
    if (e instanceof LendingError) throw e;
    const t = toLendingError(e) as { code?: string };
    // The only UNIQUE a new title can hit is the ISBN.
    if ((e as { constraint?: string }).constraint === 'uq_books_isbn') {
      throw new LendingError('ISBN_EXISTS', 'A book with this ISBN already exists', 409);
    }
    throw t;
  }
}
