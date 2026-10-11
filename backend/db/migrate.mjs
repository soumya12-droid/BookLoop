// Forward-only SQL migration runner. Targets DATABASE_URL_TEST only (see lib/env.mjs).
// Each file is applied in its own transaction; version + checksum are recorded in schema_migrations.
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { connectTarget, targetFromArgv, dbDir } from './lib/env.mjs';

const dir = path.join(dbDir, 'migrations');
const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();

// Default target: the test branch. `--target=dev` additionally needs ALLOW_DEV_TARGET=true and a
// DEV_BRANCH_ID that matches the connected branch (see docs/ENVIRONMENTS.md).
const client = await connectTarget(targetFromArgv());
try {
  const { rows: hasTable } = await client.query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  );
  if (!hasTable[0].present) {
    // Refuse to adopt a database that already has unrelated tables.
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    if (rows.length > 0) {
      throw new Error(`Target has existing tables (${rows.map((r) => r.table_name).join(', ')}) but no schema_migrations. Refusing to continue.`);
    }
    await client.query(`
      CREATE TABLE schema_migrations (
        version    TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        checksum   TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
  }

  const { rows: applied } = await client.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
  const appliedMap = new Map(applied.map((r) => [r.version, r.checksum]));
  const maxApplied = applied.length ? applied[applied.length - 1].version : '';

  let ran = 0;
  for (const file of files) {
    const version = file.slice(0, 4);
    const sql = readFileSync(path.join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');

    if (appliedMap.has(version)) {
      if (appliedMap.get(version) !== checksum) {
        throw new Error(`Migration ${file} was modified after being applied (checksum mismatch).`);
      }
      console.log(`[skip] ${file}`);
      continue;
    }
    if (version < maxApplied) {
      throw new Error(`Migration ${file} is older than the latest applied version ${maxApplied}.`);
    }

    console.log(`[run ] ${file}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)', [version, file, checksum]);
      await client.query('COMMIT');
      ran += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[FAIL] ${file}: ${err.message}`);
      if (err.position) console.error(`       at position ${err.position}`);
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode !== 1) console.log(`[done] ${ran} migration(s) applied, ${files.length - ran} already present.`);
} finally {
  await client.end();
}
