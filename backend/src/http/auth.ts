// Token issue/verify and the authentication middleware.
// Identity always comes from the verified token's subject, then the user row is re-read from the
// database on every request, so deactivation and role changes take effect immediately.
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import type { RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from '../config/env.ts';
import { forbidden, unauthenticated } from './errors.ts';

const ISSUER = 'bookloop';
const AUDIENCE = 'bookloop-api';

export interface AuthUser {
  id: string;
  role: 'MEMBER' | 'ADMIN';
  displayName: string;
}

const secretKey = (c: AppConfig) => new TextEncoder().encode(c.jwtSecret);

export async function signAccessToken(
  config: AppConfig,
  userId: string,
  opts: { issuedAtSeconds?: number; expiresAtSeconds?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(opts.issuedAtSeconds ?? now)
    .setExpirationTime(opts.expiresAtSeconds ?? now + config.jwtTtlSeconds)
    .sign(secretKey(config));
}

const uuid = z.uuid();

export async function verifyAccessToken(config: AppConfig, token: string): Promise<string> {
  const { payload } = await jwtVerify(token, secretKey(config), {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'],
  });
  const sub = uuid.safeParse(payload.sub);
  if (!sub.success) throw new Error('invalid subject');
  return sub.data;
}

export function authenticate(pool: Pool, config: AppConfig): RequestHandler {
  return async (req, res, next) => {
    try {
      const header = req.header('authorization') ?? '';
      const m = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(header);
      if (!m) throw unauthenticated();
      let userId: string;
      try {
        userId = await verifyAccessToken(config, m[1]!);
      } catch {
        throw unauthenticated(); // bad signature, expiry, issuer, audience, algorithm, subject: all identical
      }
      const r = await pool.query<{ id: string; role: 'MEMBER' | 'ADMIN'; display_name: string }>(
        `SELECT id, role, display_name FROM users WHERE id = $1 AND deactivated_at IS NULL`, [userId]);
      const row = r.rows[0];
      if (!row) throw unauthenticated();
      const user: AuthUser = { id: row.id, role: row.role, displayName: row.display_name };
      res.locals.user = user;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/**
 * Public read routes: no Authorization header means "anonymous" (res.locals.user stays unset).
 * A header that IS present goes through the full authenticate() above, unchanged, so a bad,
 * expired or deactivated-account token is still a 401 rather than silently downgraded.
 * Never use this on a route that mutates state or returns private data.
 */
export function optionalAuthenticate(strict: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (req.header('authorization') === undefined) return next();
    return strict(req, res, next);
  };
}

export const requireAdmin: RequestHandler = (_req, res, next) => {
  const u = res.locals.user as AuthUser | undefined;
  if (!u) return next(unauthenticated());
  if (u.role !== 'ADMIN') return next(forbidden('Administrator only'));
  next();
};

export function currentUser(res: Response): AuthUser {
  const u = res.locals.user as AuthUser | undefined;
  if (!u) throw unauthenticated();
  return u;
}
