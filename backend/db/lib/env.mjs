// Shared connection + safety guards for ALL database tooling and tests.
//
// Targets that exist:
//   test  (default) DATABASE_URL_TEST. Used by every tool and every test suite.
//   dev             DATABASE_URL_DIRECT. Only for `migrate` and `inspect`, only with --target=dev,
//                   ALLOW_DEV_TARGET=true and a verified DEV_BRANCH_ID. Never for seed/reset/tests.
// There is no production target and none can be named.
//
// Branch pinning: Neon exposes the connected branch id (neon.branch_id). If TEST_BRANCH_ID is set,
// every test-target connection verifies it and refuses on mismatch; seed and reset REQUIRE it, so a
// mistyped DATABASE_URL_TEST can never be truncated/dropped. The dev target always requires
// DEV_BRANCH_ID and verifies it before any statement is run.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const dbDir = path.resolve(here, '..');
export const backendDir = path.resolve(dbDir, '..');

function describe(url) {
  const u = new URL(url);
  return {
    host: u.hostname.replace('-pooler', ''),
    pooled: u.hostname.includes('-pooler'),
    db: u.pathname.replace(/^\//, ''),
  };
}
const sameEndpoint = (a, b) => a.host === b.host && a.db === b.db;

export function loadEnv() {
  const p = path.join(backendDir, '.env');
  if (existsSync(p)) process.loadEnvFile(p); // does not override variables already set
}

export function testTarget() {
  loadEnv();
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error('DATABASE_URL_TEST is empty. Tooling only runs against the test branch.');
  const t = describe(url);
  if (t.pooled) throw new Error('DATABASE_URL_TEST must be the direct (non-pooled) connection string.');
  for (const key of ['DATABASE_URL', 'DATABASE_URL_DIRECT']) {
    const other = process.env[key];
    if (!other) continue;
    if (sameEndpoint(describe(other), t)) {
      throw new Error(`DATABASE_URL_TEST resolves to the same endpoint/database as ${key}. Refusing to run.`);
    }
  }
  return { url, label: `${t.host.split('.')[0].slice(0, 7)}...:${t.db}`, name: 'test' };
}

export function devTarget() {
  loadEnv();
  if (process.env.ALLOW_DEV_TARGET !== 'true') {
    throw new Error('The dev target needs ALLOW_DEV_TARGET=true (set it on the command line, not in .env).');
  }
  if (!process.env.DEV_BRANCH_ID) {
    throw new Error('The dev target needs DEV_BRANCH_ID (the Neon branch id you intend to migrate).');
  }
  const url = process.env.DATABASE_URL_DIRECT;
  if (!url) throw new Error('DATABASE_URL_DIRECT is empty.');
  const d = describe(url);
  if (d.pooled) throw new Error('DATABASE_URL_DIRECT must be the direct (non-pooled) connection string.');
  const testUrl = process.env.DATABASE_URL_TEST;
  if (testUrl && sameEndpoint(describe(testUrl), d)) {
    throw new Error('DATABASE_URL_DIRECT is the same endpoint as DATABASE_URL_TEST; the dev target must be separate.');
  }
  return { url, label: `${d.host.split('.')[0].slice(0, 7)}...:${d.db}`, name: 'dev' };
}

export function resolveTarget(name = 'test') {
  if (name === 'test') return testTarget();
  if (name === 'dev') return devTarget();
  throw new Error(`Unknown target "${name}". Only "test" and "dev" exist; production cannot be targeted.`);
}

/** Reads --target=<name> from argv (default "test"). */
export function targetFromArgv(argv = process.argv) {
  const a = argv.find((x) => x.startsWith('--target='));
  return a ? a.slice('--target='.length) : 'test';
}

/** Fails fast (before connecting) when a destructive tool is run without a pinned branch id. */
export function requirePinConfigured(name = 'test') {
  loadEnv();
  const key = name === 'dev' ? 'DEV_BRANCH_ID' : 'TEST_BRANCH_ID';
  if (!process.env[key]) {
    throw new Error(`${key} must be set (the expected Neon branch id) for this operation.`);
  }
}

/** `queryable` is a pg Client or Pool. */
export async function assertBranchPin(queryable, name = 'test', { required = false } = {}) {
  const key = name === 'dev' ? 'DEV_BRANCH_ID' : 'TEST_BRANCH_ID';
  const pin = process.env[key];
  if (!pin) {
    if (required || name === 'dev') throw new Error(`${key} is not set; refusing.`);
    return;
  }
  const r = await queryable.query(`SELECT current_setting('neon.branch_id', true) AS branch`);
  if (r.rows[0].branch !== pin) {
    throw new Error(`Connected branch does not match ${key}; refusing.`);
  }
}

export async function connectTarget(name = 'test', { requirePin = false } = {}) {
  if (requirePin) requirePinConfigured(name);
  const { url, label } = resolveTarget(name);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await assertBranchPin(client, name, { required: requirePin });
  } catch (e) {
    await client.end().catch(() => {});
    throw e;
  }
  console.log(`[db] connected to ${name.toUpperCase()} target ${label}`);
  return client;
}

export async function connectTest(opts = {}) {
  return connectTarget('test', opts);
}
