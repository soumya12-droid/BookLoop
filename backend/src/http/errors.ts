// Central error model and middleware. Responses never contain SQL, stack traces or secrets.
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { LendingError, toLendingError } from '../services/errors.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    if (headers) this.headers = headers;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new ApiError(400, code, message, details);
export const unauthenticated = (message = 'Authentication required') =>
  new ApiError(401, 'UNAUTHENTICATED', message, undefined, { 'WWW-Authenticate': 'Bearer' });
export const forbidden = (message = 'You are not allowed to do that') => new ApiError(403, 'FORBIDDEN', message);
export const notFound = (code = 'NOT_FOUND', message = 'Resource not found') => new ApiError(404, code, message);

/** Masks anything that looks like a connection string before it reaches a log line. */
export function redact(text: string): string {
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '[redacted-url]');
}

interface Mapped {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  headers?: Record<string, string>;
}

function mapError(err: unknown): Mapped | null {
  if (err instanceof ApiError) {
    return { status: err.status, code: err.code, message: err.message, details: err.details, headers: err.headers };
  }
  const translated = toLendingError(err);
  if (translated instanceof LendingError) {
    const retryable = translated.code === 'RESOURCE_BUSY' || translated.code === 'RETRY';
    return {
      status: translated.status,
      code: translated.code,
      message: translated.message,
      details: translated.details,
      headers: retryable ? { 'Retry-After': '1' } : undefined,
    };
  }
  const e = err as { type?: string; status?: number } | null;
  if (e && e.type === 'entity.parse.failed') {
    return { status: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON' };
  }
  if (e && e.type === 'entity.too.large') {
    return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' };
  }
  // Remaining client errors raised by the HTTP stack (body-parser / http-errors): unsupported
  // content-encoding, unsupported charset, aborted request... They are the client's fault: 4xx.
  const h = err as { status?: unknown; statusCode?: unknown; expose?: unknown } | null;
  const st = typeof h?.status === 'number' ? h.status : typeof h?.statusCode === 'number' ? h.statusCode : 0;
  if (st >= 400 && st < 500 && h?.expose === true) {
    return {
      status: st,
      code: st === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'BAD_REQUEST',
      message: 'The request could not be processed',
    };
  }
  return null;
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new ApiError(404, 'NOT_FOUND', 'Route not found'));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const requestId = (res.locals.requestId as string | undefined) ?? 'unknown';
  const mapped = mapError(err);
  if (mapped) {
    if (mapped.headers) for (const [k, v] of Object.entries(mapped.headers)) res.setHeader(k, v);
    res.status(mapped.status).json({
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details !== undefined ? { details: mapped.details } : {}),
        requestId,
      },
    });
    return;
  }
  // Unexpected: log a redacted summary server-side only; the client gets a generic message.
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? redact(err.message) : '';
  const pgCode = (err as { code?: string } | null)?.code ?? '-';
  console.error(`[error] request=${requestId} ${name} code=${pgCode} ${message}`);
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId },
  });
};
