// Typed configuration. Reads names only from the environment; values are never logged.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const backendDir = path.resolve(here, '..', '..');

export interface RateLimitConfig {
  windowMs: number;
  loginMax: number;
  registerMax: number;
  /** Per-IP cap on anonymous catalogue reads per window (signed-in requests are not counted). */
  publicReadMax?: number;
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  /** Interface to bind. Loopback by default; set HOST=0.0.0.0 only behind a trusted proxy/container. */
  host: string;
  databaseUrl: string;
  jwtSecret: string;
  jwtTtlSeconds: number;
  bcryptCost: number;
  /** Upper bound for waiting on a copy/request/loan row lock (PostgreSQL lock_timeout). */
  lockTimeoutMs: number;
  corsOrigins: string[];
  trustProxy: boolean | number;
  rateLimit: RateLimitConfig;
}

/** Loads backend/.env into process.env if the file exists. Existing variables are not overridden. */
export function loadDotEnv(): void {
  const p = path.join(backendDir, '.env');
  if (existsSync(p)) process.loadEnvFile(p);
}

function int(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<AppConfig> = {},
): AppConfig {
  const base: AppConfig = {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: int(env.PORT, 4000),
    host: env.HOST?.trim() || '127.0.0.1',
    databaseUrl: env.DATABASE_URL ?? '',
    jwtSecret: env.JWT_SECRET ?? '',
    jwtTtlSeconds: int(env.JWT_TTL_SECONDS, 3600),
    bcryptCost: int(env.BCRYPT_COST, 12),
    lockTimeoutMs: int(env.LOCK_TIMEOUT_MS, 3000),
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === undefined ? false : env.TRUST_PROXY === 'true' ? true : int(env.TRUST_PROXY, 0) || false,
    rateLimit: {
      windowMs: int(env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
      loginMax: int(env.RATE_LIMIT_LOGIN_MAX, 10),
      registerMax: int(env.RATE_LIMIT_REGISTER_MAX, 10),
      publicReadMax: int(env.RATE_LIMIT_PUBLIC_READ_MAX, 600),
    },
  };
  const cfg: AppConfig = { ...base, ...overrides };

  // Fail fast, naming the variable but never echoing a value.
  if (cfg.jwtSecret.length < 32) {
    throw new Error('JWT_SECRET is missing or shorter than 32 characters');
  }
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is not set');
  if (cfg.bcryptCost < 4 || cfg.bcryptCost > 15) throw new Error('BCRYPT_COST must be between 4 and 15');
  return cfg;
}
