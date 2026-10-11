// Authentication and profile: register, login, me, update profile.
import { rateLimit } from 'express-rate-limit';
import { ApiError } from '../http/errors.ts';
import { currentUser, signAccessToken } from '../http/auth.ts';
import { parse, z } from '../http/validate.ts';
import { getUser, loginUser, registerUser, updateProfile } from '../services/auth.ts';
import type { RouteModule } from './context.ts';

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const registerSchema = z.object({
  email: z.string().trim().pipe(z.email().max(254)),
  password: z.string().min(10, 'Password must be at least 10 characters').max(72)
    .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password must be at most 72 bytes'),
  displayName: z.string().trim().min(1).max(80),
  defaultPickupLocation: optionalText(200),
  contactInfo: optionalText(200),
}).strict(); // rejects "role" and any other unknown field

const loginSchema = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
}).strict();

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  defaultPickupLocation: optionalText(200),
  contactInfo: optionalText(200),
}).strict();

export const authRoutes: RouteModule = (router, { pool, config, auth }) => {
  const retryAfter = String(Math.ceil(config.rateLimit.windowMs / 1000));
  const loginLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs, limit: config.rateLimit.loginMax,
    standardHeaders: 'draft-8', legacyHeaders: false,
    skipSuccessfulRequests: true,                // only failed logins count against the limit
    handler: (_req, _res, next) => next(new ApiError(
      429, 'RATE_LIMITED', 'Too many login attempts; try again later', undefined, { 'Retry-After': retryAfter })),
  });
  const registerLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs, limit: config.rateLimit.registerMax,
    standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, _res, next) => next(new ApiError(
      429, 'RATE_LIMITED', 'Too many registration attempts; try again later', undefined, { 'Retry-After': retryAfter })),
  });

  router.post('/auth/register', registerLimiter, async (req, res) => {
    const body = parse(registerSchema, req.body ?? {}, 'registration');
    const user = await registerUser(pool, body, config.bcryptCost);
    const token = await signAccessToken(config, user.id);
    res.status(201).json({ data: { user, token, tokenType: 'Bearer', expiresIn: config.jwtTtlSeconds } });
  });

  router.post('/auth/login', loginLimiter, async (req, res) => {
    const body = parse(loginSchema, req.body ?? {}, 'login');
    const user = await loginUser(pool, body.email, body.password, config.bcryptCost);
    const token = await signAccessToken(config, user.id);
    res.json({ data: { user, token, tokenType: 'Bearer', expiresIn: config.jwtTtlSeconds } });
  });

  router.get('/auth/me', auth, async (_req, res) => {
    const me = await getUser(pool, currentUser(res).id);
    res.json({ data: me });
  });

  router.patch('/users/me', auth, async (req, res) => {
    const patch = parse(profileSchema, req.body ?? {}, 'profile');
    const me = await updateProfile(pool, currentUser(res).id, patch);
    res.json({ data: me });
  });
};
