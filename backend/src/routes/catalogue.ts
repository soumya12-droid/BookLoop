// Catalogue and discovery: genres, books, copies, reviews.
// Read-only browsing is PUBLIC (optional auth); every write and every "mine" route requires a token.
// Anonymous responses use the public DTOs: no member ids, pickup places, notes or loan ids.
import { rateLimit } from 'express-rate-limit';
import { currentUser } from '../http/auth.ts';
import type { AuthUser } from '../http/auth.ts';
import { ApiError } from '../http/errors.ts';
import { idParam, normalizeIsbn13, pageQuery, parse, z } from '../http/validate.ts';
import {
  bookExists, getBook, getCopy, listCopiesForBook, listGenres, listOwnCopies, listReviews, searchBooks,
  toPublicCopy, toPublicReview,
} from '../repositories/catalogue.ts';
import { createBook } from '../services/catalogue.ts';
import { lending } from '../services/lending.ts';
import type { RouteModule } from './context.ts';

const bookSearchQuery = pageQuery.extend({
  q: z.string().trim().max(100).optional(),
  genreId: z.uuid().optional(),
  availableOnly: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

const text = (max: number) => z.string().trim().min(1).max(max);

const newBookSchema = z.object({
  title: text(300),
  isbn: z.string().trim().max(20).optional().nullable().transform((v, ctx) => {
    if (v === undefined || v === null || v === '') return null;
    const n = normalizeIsbn13(v);
    if (!n) ctx.addIssue({ code: 'custom', message: 'ISBN must be a valid ISBN-13' });
    return n;
  }),
  edition: text(60).optional().nullable(),
  publisher: text(120).optional().nullable(),
  publicationYear: z.number().int().min(1400).max(2100).optional().nullable(),
  description: z.string().trim().max(4000).optional().nullable(),
  authors: z.array(text(120)).max(10).optional(),
  genreIds: z.array(z.uuid()).max(10).optional(),
}).strict();

const newCopySchema = z.object({
  condition: z.enum(['NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'POOR']).optional(),
  pickupLocation: z.string().trim().max(200).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
}).strict();

const patchCopySchema = z.object({ isListed: z.boolean() }).strict();

export const catalogueRoutes: RouteModule = (router, { pool, config, auth, optionalAuth }) => {
  const lock = { lockTimeoutMs: config.lockTimeoutMs };
  /** The caller if a valid token was presented, otherwise null (public routes only). */
  const maybeUser = (res: { locals: Record<string, unknown> }) => (res.locals.user as AuthUser | undefined) ?? null;

  // Anonymous reads hit the database without a credential, so they are capped per client address.
  // Signed-in requests are not counted. Over the cap: 429 RATE_LIMITED with Retry-After.
  const retryAfter = String(Math.ceil(config.rateLimit.windowMs / 1000));
  const publicLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs, limit: config.rateLimit.publicReadMax ?? 600,
    standardHeaders: 'draft-8', legacyHeaders: false,
    skip: (_req, res) => res.locals.user !== undefined,
    handler: (_req, _res, next) => next(new ApiError(
      429, 'RATE_LIMITED', 'Too many requests; try again later', undefined, { 'Retry-After': retryAfter })),
  });

  router.get('/genres', optionalAuth, publicLimiter, async (_req, res) => {
    res.json({ data: await listGenres(pool) });
  });

  router.get('/books', optionalAuth, publicLimiter, async (req, res) => {
    const q = parse(bookSearchQuery, req.query, 'query');
    const r = await searchBooks(pool, {
      q: q.q || undefined, genreId: q.genreId, availableOnly: q.availableOnly,
      limit: q.limit, offset: q.offset,
    });
    res.json({ data: r.items, page: { limit: q.limit, offset: q.offset, total: r.total } });
  });

  router.get('/books/:bookId', optionalAuth, publicLimiter, async (req, res) => {
    const book = await getBook(pool, idParam(req.params.bookId, 'bookId'));
    if (!book) throw new ApiError(404, 'BOOK_NOT_FOUND', 'Book not found');
    res.json({ data: book });
  });

  router.post('/books', auth, async (req, res) => {
    currentUser(res);
    const body = parse(newBookSchema, req.body ?? {}, 'book');
    const id = await createBook(pool, {
      title: body.title, isbn: body.isbn, edition: body.edition, publisher: body.publisher,
      publicationYear: body.publicationYear, description: body.description,
      authors: body.authors, genreIds: body.genreIds,
    }, config.lockTimeoutMs);
    res.status(201).json({ data: await getBook(pool, id) });
  });

  router.get('/books/:bookId/copies', optionalAuth, publicLimiter, async (req, res) => {
    const bookId = idParam(req.params.bookId, 'bookId');
    if (!(await bookExists(pool, bookId))) throw new ApiError(404, 'BOOK_NOT_FOUND', 'Book not found');
    const u = maybeUser(res);
    const copies = await listCopiesForBook(pool, bookId, u?.id ?? null, u?.role === 'ADMIN');
    res.json({ data: u ? copies : copies.map(toPublicCopy) });
  });

  router.post('/books/:bookId/copies', auth, async (req, res) => {
    const bookId = idParam(req.params.bookId, 'bookId');
    const body = parse(newCopySchema, req.body ?? {}, 'copy');
    const u = currentUser(res);
    const created = await lending.createCopy(pool, u.id, {
      bookId, condition: body.condition, pickupLocation: body.pickupLocation, notes: body.notes,
    }, lock);
    res.status(201).json({ data: await getCopy(pool, created.id, u.id, u.role === 'ADMIN') });
  });

  router.get('/copies/:copyId', optionalAuth, publicLimiter, async (req, res) => {
    const u = maybeUser(res);
    const copy = await getCopy(pool, idParam(req.params.copyId, 'copyId'), u?.id ?? null, u?.role === 'ADMIN');
    if (!copy) throw new ApiError(404, 'COPY_NOT_FOUND', 'Copy not found');
    res.json({ data: u ? copy : toPublicCopy(copy) });
  });

  // List / unlist a copy. Availability itself is never written; it is derived.
  router.patch('/copies/:copyId', auth, async (req, res) => {
    const copyId = idParam(req.params.copyId, 'copyId');
    const body = parse(patchCopySchema, req.body ?? {}, 'copy');
    const u = currentUser(res);
    await lending.setListing(pool, u.id, copyId, body.isListed, lock);
    res.json({ data: await getCopy(pool, copyId, u.id, u.role === 'ADMIN') });
  });

  router.get('/users/me/copies', auth, async (_req, res) => {
    res.json({ data: await listOwnCopies(pool, currentUser(res).id) });
  });

  router.get('/books/:bookId/reviews', optionalAuth, publicLimiter, async (req, res) => {
    const bookId = idParam(req.params.bookId, 'bookId');
    const page = parse(pageQuery, req.query, 'query');
    if (!(await bookExists(pool, bookId))) throw new ApiError(404, 'BOOK_NOT_FOUND', 'Book not found');
    const r = await listReviews(pool, bookId, page.limit, page.offset);
    const items = maybeUser(res) ? r.items : r.items.map(toPublicReview);
    res.json({ data: items, page: { limit: page.limit, offset: page.offset, total: r.total } });
  });
};
