// Registration, login and profile updates. Explicit parameterised SQL.
import bcrypt from 'bcryptjs';
import type { Pool } from 'pg';
import { LendingError, toLendingError } from './errors.ts';

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  role: 'MEMBER' | 'ADMIN';
  defaultPickupLocation: string | null;
  contactInfo: string | null;
  createdAt: Date;
}

interface UserRow {
  id: string; email: string; display_name: string; role: 'MEMBER' | 'ADMIN';
  default_pickup_location: string | null; contact_info: string | null; created_at: Date;
}

const USER_COLS = `id, email::text AS email, display_name, role, default_pickup_location, contact_info, created_at`;

export function toUserDto(r: UserRow): UserDto {
  return {
    id: r.id, email: r.email, displayName: r.display_name, role: r.role,
    defaultPickupLocation: r.default_pickup_location, contactInfo: r.contact_info, createdAt: r.created_at,
  };
}

/** Same normalisation everywhere: trim and lower-case (the column is citext, so this is cosmetic). */
export const normalizeEmail = (e: string) => e.trim().toLowerCase();

// A real bcrypt hash compared against when the email is unknown, so the "no such user" path costs
// the same as a wrong password (no timing oracle for account existence). It MUST be generated at the
// same cost as real account hashes: bcrypt compare at cost 12 is ~5x slower than at cost 10, which
// would make unknown emails answer visibly faster. Built lazily per cost and warmed at startup.
const dummyHashes = new Map<number, string>();
export function dummyHashFor(cost: number): string {
  let h = dummyHashes.get(cost);
  if (!h) {
    h = bcrypt.hashSync('not-a-real-account-password', cost);
    dummyHashes.set(cost, h);
  }
  return h;
}

export async function registerUser(
  pool: Pool,
  input: { email: string; password: string; displayName: string; defaultPickupLocation?: string | null; contactInfo?: string | null },
  bcryptCost: number,
): Promise<UserDto> {
  const hash = await bcrypt.hash(input.password, bcryptCost);
  try {
    // role is never taken from the caller: the column default 'MEMBER' applies.
    const r = await pool.query<UserRow>(
      `INSERT INTO users (email, password_hash, display_name, default_pickup_location, contact_info)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${USER_COLS}`,
      [normalizeEmail(input.email), hash, input.displayName.trim(), input.defaultPickupLocation ?? null, input.contactInfo ?? null]);
    return toUserDto(r.rows[0]!);
  } catch (e) {
    throw toLendingError(e); // 23505 uq_users_email -> 409 EMAIL_TAKEN
  }
}

export async function loginUser(
  pool: Pick<Pool, 'query'>, email: string, password: string, bcryptCost = 12,
): Promise<UserDto> {
  const r = await pool.query<UserRow & { password_hash: string; deactivated_at: Date | null }>(
    `SELECT ${USER_COLS}, password_hash, deactivated_at FROM users WHERE email = $1`, [normalizeEmail(email)]);
  const row = r.rows[0];
  const ok = await bcrypt.compare(password, row?.password_hash ?? dummyHashFor(bcryptCost));
  if (!row || !ok || row.deactivated_at !== null) {
    throw new LendingError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
  }
  return toUserDto(row);
}

export async function getUser(pool: Pool, userId: string): Promise<UserDto | null> {
  const r = await pool.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [userId]);
  return r.rows[0] ? toUserDto(r.rows[0]) : null;
}

export async function updateProfile(
  pool: Pool, userId: string,
  patch: { displayName?: string; defaultPickupLocation?: string | null; contactInfo?: string | null },
): Promise<UserDto> {
  // Only the fields present in the patch are changed; null clears an optional field.
  const sets: string[] = [];
  const args: unknown[] = [userId];
  const add = (col: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`); };
  if (patch.displayName !== undefined) add('display_name', patch.displayName.trim());
  if (patch.defaultPickupLocation !== undefined) add('default_pickup_location', patch.defaultPickupLocation);
  if (patch.contactInfo !== undefined) add('contact_info', patch.contactInfo);
  if (sets.length === 0) {
    const u = await getUser(pool, userId);
    if (!u) throw new LendingError('UNAUTHENTICATED', 'Unknown user', 401);
    return u;
  }
  try {
    const r = await pool.query<UserRow>(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1 AND deactivated_at IS NULL RETURNING ${USER_COLS}`, args);
    if (!r.rows[0]) throw new LendingError('UNAUTHENTICATED', 'Unknown user', 401);
    return toUserDto(r.rows[0]);
  } catch (e) {
    throw toLendingError(e);
  }
}
