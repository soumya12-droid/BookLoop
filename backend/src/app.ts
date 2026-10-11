// Express application factory. No module-level state: tests build isolated apps with their own
// pool and configuration (e.g. very low rate limits, short lock timeouts).
import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import type { Express, RequestHandler } from 'express';
import helmet from 'helmet';
import type { Pool } from 'pg';
import type { AppConfig } from './config/env.ts';
import { authenticate, optionalAuthenticate } from './http/auth.ts';
import { errorHandler, notFoundHandler } from './http/errors.ts';
import { authRoutes } from './routes/auth.ts';
import { catalogueRoutes } from './routes/catalogue.ts';
import { lendingRoutes } from './routes/lending.ts';
import { dummyHashFor } from './services/auth.ts';

export interface AppDeps {
  pool: Pool;
  config: AppConfig;
}

const requestId: RequestHandler = (req, res, next) => {
  const id = randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
};

const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

export function createApp({ pool, config }: AppDeps): Express {
  dummyHashFor(config.bcryptCost); // warm the constant-time login comparison at the real cost
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(requestId);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins.length > 0 ? config.corsOrigins : false }));
  app.use(noStore);
  app.use(express.json({ limit: '32kb' }));

  // Health: no credentials, no versions, no connection details.
  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  const api = express.Router();
  const auth = authenticate(pool, config);
  const ctx = { pool, config, auth, optionalAuth: optionalAuthenticate(auth) };
  authRoutes(api, ctx);
  catalogueRoutes(api, ctx);
  lendingRoutes(api, ctx);
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
