// Request validation helpers (zod). Bodies use .strict(): unknown fields (e.g. "role") are rejected.
import { z } from 'zod';
import { badRequest } from './errors.ts';

export { z };

/** PostgreSQL text cannot hold U+0000; reaching the database it would surface as a 500. */
function hasNul(v: unknown, depth = 0): boolean {
  if (typeof v === 'string') return v.includes('\u0000');
  if (depth > 8) return false;
  if (Array.isArray(v)) return v.some((x) => hasNul(x, depth + 1));
  if (v !== null && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).some(([k, x]) => k.includes('\u0000') || hasNul(x, depth + 1));
  }
  return false;
}

export function parse<T>(schema: z.ZodType<T>, data: unknown, what = 'request'): T {
  if (hasNul(data)) {
    throw badRequest('VALIDATION_ERROR', `Invalid ${what}`, [{ path: '', message: 'NUL characters are not allowed' }]);
  }
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw badRequest('VALIDATION_ERROR', `Invalid ${what}`,
    r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
}

const uuid = z.uuid();
/** Validates a path parameter that must be a UUID. */
export function idParam(value: unknown, name: string): string {
  const r = uuid.safeParse(value);
  if (!r.success) throw badRequest('INVALID_ID', `${name} must be a valid identifier`);
  return r.data;
}

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/** ISBN-13 with checksum, hyphens/spaces allowed on input; returns digits only. */
export function normalizeIsbn13(raw: string): string | null {
  const digits = raw.replace(/[-\s]/g, '');
  if (!/^97[89]\d{10}$/.test(digits)) return null;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(digits[12]) ? digits : null;
}
