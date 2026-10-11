// Guarded, repeatable demo seed. DESTRUCTIVE to BookLoop data on the target: it truncates every
// application table first. Runs only against DATABASE_URL_TEST and only with ALLOW_SEED=true.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { connectTest, dbDir } from './lib/env.mjs';
import { loadDemo } from './seed/demo.mjs';

if (process.env.ALLOW_SEED !== 'true') {
  console.error('Refusing: set ALLOW_SEED=true to seed (this truncates all BookLoop tables on the TEST branch).');
  process.exit(1);
}

// TRUNCATE is destructive: the expected Neon branch id must be pinned (TEST_BRANCH_ID) and matches.
const client = await connectTest({ requirePin: true });
try {
  const { rows } = await client.query(`SELECT to_regclass('public.loans') IS NOT NULL AS migrated`);
  if (!rows[0].migrated) throw new Error('Schema is not migrated. Run db:migrate first.');

  await client.query('BEGIN');
  await client.query(`TRUNCATE reviews, loans, borrow_requests, book_genres, book_authors,
                      copies, genres, authors, books, users CASCADE`);
  await client.query(readFileSync(path.join(dbDir, 'seed', '001_reference.sql'), 'utf8'));
  await loadDemo(client);
  await client.query('COMMIT');   // deferred request/loan pairing check (T-G) runs here

  const n = async (t) => (await client.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
  console.log('[seed] committed. Row counts:');
  for (const t of ['users', 'genres', 'authors', 'books', 'copies', 'borrow_requests', 'loans', 'reviews']) {
    console.log(`  ${t}: ${await n(t)}`);
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`[seed] FAILED and rolled back: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
