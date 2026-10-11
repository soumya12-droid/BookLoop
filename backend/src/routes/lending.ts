// Borrow requests, loans, reviews and admin moderation. Thin: every state change goes through the
// existing lending service (locks, state machine, availability rules). Routes only authenticate,
// validate, call the service and shape the response.
import { currentUser, requireAdmin } from '../http/auth.ts';
import { ApiError } from '../http/errors.ts';
import { idParam, pageQuery, parse, z } from '../http/validate.ts';
import { getCopy } from '../repositories/catalogue.ts';
import {
  getLoan, getRequest, listLoans, listRequests,
  type LoanRole, type LoanStatus, type RequestRole, type Viewer,
} from '../repositories/lending.ts';
import { lending } from '../services/lending.ts';
import type { RouteModule } from './context.ts';

const createRequestSchema = z.object({
  message: z.string().trim().max(500).nullable().optional(),
}).strict();

const handoffSchema = z.object({
  days: z.number().int().min(1).max(60).optional(),
}).strict();

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).nullable().optional(),
}).strict();

const requestListQuery = pageQuery.extend({
  role: z.enum(['requester', 'owner', 'all']).default('requester'),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'FULFILLED']).optional(),
});

const loanListQuery = pageQuery.extend({
  role: z.enum(['borrower', 'lender', 'all']).default('borrower'),
  status: z.enum(['active', 'returned', 'overdue']).optional(),
});

export const lendingRoutes: RouteModule = (router, { pool, config, auth }) => {
  const lock = { lockTimeoutMs: config.lockTimeoutMs };
  const viewer = (res: Parameters<typeof currentUser>[0]): Viewer => {
    const u = currentUser(res);
    return { id: u.id, isAdmin: u.role === 'ADMIN' };
  };
  const requestOr404 = async (requestId: string, v: Viewer) => {
    const r = await getRequest(pool, requestId, v);
    if (!r) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Request not found');
    return r;
  };
  const loanOr404 = async (loanId: string, v: Viewer) => {
    const l = await getLoan(pool, loanId, v);
    if (!l) throw new ApiError(404, 'LOAN_NOT_FOUND', 'Loan not found');
    return l;
  };

  // ---- requests ----
  router.post('/copies/:copyId/requests', auth, async (req, res) => {
    const copyId = idParam(req.params.copyId, 'copyId');
    const body = parse(createRequestSchema, req.body ?? {}, 'request');
    const v = viewer(res);
    // Same concealment rule as GET /copies/:copyId: an unlisted copy, or one whose owner is
    // deactivated, is indistinguishable from a copy that does not exist. (The service remains the
    // authority on availability: on loan / reserved / overdue are still 409 for visible copies.)
    if (!(await getCopy(pool, copyId, v.id, v.isAdmin))) {
      throw new ApiError(404, 'COPY_NOT_FOUND', 'Copy not found');
    }
    const created = await lending.createRequest(pool, v.id, copyId, body.message ?? null, lock);
    res.status(201).json({ data: await requestOr404(created.id, v) });
  });

  router.get('/requests', auth, async (req, res) => {
    const q = parse(requestListQuery, req.query, 'query');
    const v = viewer(res);
    if (q.role === 'all' && !v.isAdmin) throw new ApiError(403, 'FORBIDDEN', 'Administrator only');
    const r = await listRequests(pool, v, q.role as RequestRole, q.status, q.limit, q.offset);
    res.json({ data: r.items, page: { limit: q.limit, offset: q.offset, total: r.total } });
  });

  router.get('/requests/:requestId', auth, async (req, res) => {
    res.json({ data: await requestOr404(idParam(req.params.requestId, 'requestId'), viewer(res)) });
  });

  const transition = (op: 'approveRequest' | 'rejectRequest' | 'cancelRequest') =>
    async (req: import('express').Request, res: import('express').Response) => {
      const requestId = idParam(req.params.requestId, 'requestId');
      await lending[op](pool, currentUser(res).id, requestId, lock);
      res.json({ data: await requestOr404(requestId, viewer(res)) });
    };
  router.post('/requests/:requestId/approve', auth, transition('approveRequest'));
  router.post('/requests/:requestId/reject', auth, transition('rejectRequest'));
  router.post('/requests/:requestId/cancel', auth, transition('cancelRequest'));

  router.post('/requests/:requestId/handoff', auth, async (req, res) => {
    const requestId = idParam(req.params.requestId, 'requestId');
    const body = parse(handoffSchema, req.body ?? {}, 'handoff');
    const loan = await lending.handoff(pool, currentUser(res).id, requestId, body.days ?? 14, lock);
    res.status(201).json({ data: await loanOr404(loan.id, viewer(res)) });
  });

  // ---- loans ----
  router.get('/loans', auth, async (req, res) => {
    const q = parse(loanListQuery, req.query, 'query');
    const v = viewer(res);
    if (q.role === 'all' && !v.isAdmin) throw new ApiError(403, 'FORBIDDEN', 'Administrator only');
    const r = await listLoans(pool, v, q.role as LoanRole, q.status as LoanStatus | undefined, q.limit, q.offset);
    res.json({ data: r.items, page: { limit: q.limit, offset: q.offset, total: r.total } });
  });

  router.get('/loans/:loanId', auth, async (req, res) => {
    res.json({ data: await loanOr404(idParam(req.params.loanId, 'loanId'), viewer(res)) });
  });

  router.post('/loans/:loanId/return', auth, async (req, res) => {
    const loanId = idParam(req.params.loanId, 'loanId');
    await lending.returnLoan(pool, currentUser(res).id, loanId, lock);
    res.json({ data: await loanOr404(loanId, viewer(res)) });
  });

  router.post('/loans/:loanId/review', auth, async (req, res) => {
    const loanId = idParam(req.params.loanId, 'loanId');
    const body = parse(reviewSchema, req.body ?? {}, 'review');
    const review = await lending.createReview(pool, currentUser(res).id, loanId, body.rating, body.comment ?? null, lock);
    res.status(201).json({ data: review });
  });

  // ---- administration (never public) ----
  router.post('/admin/users/:userId/deactivate', auth, requireAdmin, async (req, res) => {
    const userId = idParam(req.params.userId, 'userId');
    const r = await lending.deactivateUser(pool, currentUser(res).id, userId, lock);
    res.json({ data: r });
  });
};
