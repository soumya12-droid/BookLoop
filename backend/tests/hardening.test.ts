// Regression tests for defects found in the Phase 3 audit. No fixtures are created.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { loadConfig } from '../src/config/env.ts';
import { assertSchemaReady } from '../src/db/ready.ts';
import { dummyHashFor, loginUser } from '../src/services/auth.ts';
import { LendingError } from '../src/services/errors.ts';
import { pool } from './helpers.ts';

after(async () => { await pool.end(); });

// ---------- login timing: unknown email must cost the same as a wrong password ----------
test('dummy hash is generated at the configured cost and memoised', () => {
  const h12 = dummyHashFor(12);
  assert.match(h12, /^\$2[aby]\$12\$/);
  assert.equal(dummyHashFor(12), h12);
  assert.match(dummyHashFor(6), /^\$2[aby]\$06\$/);
});

test('login: unknown-email path performs a bcrypt comparison at the REAL cost (regression: it used cost 10)', async () => {
  const COST = 12;
  const realHash = bcrypt.hashSync('right-password-123', COST);
  const row = {
    id: '00000000-0000-4000-8000-000000000001', email: 'known@example.test', display_name: 'K', role: 'MEMBER',
    default_pickup_location: null, contact_info: null, created_at: new Date(), password_hash: realHash, deactivated_at: null,
  };
  const fakePool = {
    query: async (_sql: string, params: unknown[]) => ({ rows: params[0] === 'known@example.test' ? [row] : [] }),
  };
  const timeIt = async (email: string, pw: string) => {
    const t = process.hrtime.bigint();
    await assert.rejects(loginUser(fakePool as never, email, pw, COST), (e: unknown) =>
      e instanceof LendingError && e.code === 'INVALID_CREDENTIALS');
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  dummyHashFor(COST);                                            // warm (as createApp does)
  const unknown = await timeIt('nobody@example.test', 'whatever-password');
  const wrongPw = await timeIt('known@example.test', 'wrong-password-123');

  // Reference: what a cost-10 comparison costs on THIS machine. The old bug made the unknown-email
  // path take about this long; the fix must take roughly as long as a cost-12 comparison (~4x more).
  const ref10 = bcrypt.hashSync('x', 10);
  const t10 = process.hrtime.bigint(); bcrypt.compareSync('y', ref10);
  const cost10 = Number(process.hrtime.bigint() - t10) / 1e6;

  assert.ok(unknown > cost10 * 2.5, `unknown-email login took ${unknown.toFixed(0)}ms, cost-10 reference ${cost10.toFixed(0)}ms`);
  const ratio = unknown / wrongPw;
  assert.ok(ratio > 0.5 && ratio < 2, `unknown ${unknown.toFixed(0)}ms vs wrong-password ${wrongPw.toFixed(0)}ms`);
});

// ---------- configuration ----------
test('config: binds to loopback by default; HOST overrides; invalid secrets fail without echoing them', () => {
  const ok = { JWT_SECRET: 'a'.repeat(40), DATABASE_URL: 'postgresql://x.invalid/x' };
  assert.equal(loadConfig(ok).host, '127.0.0.1');
  assert.equal(loadConfig({ ...ok, HOST: '0.0.0.0' }).host, '0.0.0.0');
  assert.equal(loadConfig({ ...ok, HOST: '   ' }).host, '127.0.0.1');

  const short = 'short-secret-value';
  try {
    loadConfig({ JWT_SECRET: short, DATABASE_URL: 'postgresql://x.invalid/x' });
    assert.fail('expected a configuration error');
  } catch (e) {
    assert.match((e as Error).message, /JWT_SECRET/);
    assert.doesNotMatch((e as Error).message, new RegExp(short));
  }
  assert.throws(() => loadConfig({ JWT_SECRET: 'a'.repeat(40) }), /DATABASE_URL/);
  assert.throws(() => loadConfig({ ...ok, BCRYPT_COST: '3' }), /BCRYPT_COST/);
});

// ---------- startup safety ----------
test('assertSchemaReady: passes on the migrated test branch', async () => {
  await assertSchemaReady(pool);
});

test('assertSchemaReady: refuses an unmigrated or outdated database, with a message free of connection details', async () => {
  const none = { query: async () => ({ rows: [{ present: false }] }) };
  await assert.rejects(assertSchemaReady(none), /not migrated/);

  let n = 0;
  const behind = { query: async () => ({ rows: n++ === 0 ? [{ present: true }] : [{ latest: '0007' }] }) };
  await assert.rejects(assertSchemaReady(behind), (e: Error) => /behind/.test(e.message) && /0009/.test(e.message));

  let m = 0;
  const empty = { query: async () => ({ rows: m++ === 0 ? [{ present: true }] : [{ latest: null }] }) };
  await assert.rejects(assertSchemaReady(empty), /behind/);

  for (const db of [none, behind, empty]) {
    try { await assertSchemaReady(db as never); } catch (e) {
      assert.doesNotMatch((e as Error).message, /postgres(ql)?:\/\/|password/i);
    }
  }
});
