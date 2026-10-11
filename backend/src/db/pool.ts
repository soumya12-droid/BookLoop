import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 10_000,      // Neon computes suspend when idle; do not hold stale sockets
    connectionTimeoutMillis: 20_000, // allow for a cold start
  });
  // An idle client can be dropped by the server; without a listener this would crash the process.
  pool.on('error', (err) => {
    console.error('[pool] idle client error:', err.message);
  });
  return pool;
}

export interface TxOptions {
  /** Upper bound for waiting on a row lock inside this transaction. Default 3000 ms. */
  lockTimeoutMs?: number;
}

/**
 * One checked-out client per transaction (PRD 8.2): BEGIN, SET LOCAL lock_timeout, work, COMMIT.
 * Any error rolls back and is re-thrown unchanged; the client is always released.
 * Never use pool.query() for statements that must share a transaction.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (tx: Tx) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = ${Math.trunc(opts.lockTimeoutMs ?? 3000)}`);
    const out = await fn(client);
    await client.query('COMMIT'); // deferred constraint triggers (T-G) fire here
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true; // connection is unusable; make the pool discard it
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
