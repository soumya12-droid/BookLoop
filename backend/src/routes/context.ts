import type { Router, RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from '../config/env.ts';

export interface RouteContext {
  pool: Pool;
  config: AppConfig;
  /** Authentication middleware: 401 unless a valid token for an active user is presented. */
  auth: RequestHandler;
  /** Anonymous allowed; a presented token is still fully verified. Read-only public routes only. */
  optionalAuth: RequestHandler;
}

export type RouteModule = (router: Router, ctx: RouteContext) => void;
