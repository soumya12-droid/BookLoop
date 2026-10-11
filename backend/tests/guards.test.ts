// Tooling guards: no database connection is made by any test in this file.
// They prove that destructive/dev tooling refuses BEFORE connecting, and that nothing can target
// an unnamed ("production") environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBranchPin, requirePinConfigured, resolveTarget, targetFromArgv } from '../db/lib/env.mjs';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Sets environment variables for the duration of `fn`. Awaits async bodies before restoring. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  let out: T;
  try {
    out = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (out instanceof Promise) {
    return out.finally(restore) as T;   // async body: keep the variables until it settles
  }
  restore();
  return out;
}

const FAKE_TEST = 'postgresql://u:p@ep-test-aaa.example.invalid/neondb';
const FAKE_DEV = 'postgresql://u:p@ep-dev-bbb.example.invalid/neondb';
const FAKE_DEV_POOLED = 'postgresql://u:p@ep-dev-bbb-pooler.example.invalid/neondb';

test('target resolution: only "test" and "dev" exist; "production" and anything else are refused', () => {
  withEnv({ DATABASE_URL_TEST: FAKE_TEST, DATABASE_URL_DIRECT: FAKE_DEV, DATABASE_URL: FAKE_DEV_POOLED }, () => {
    assert.equal(resolveTarget('test').name, 'test');
    for (const bad of ['prod', 'production', 'main', '', 'TEST']) {
      assert.throws(() => resolveTarget(bad), /Unknown target/);
    }
  });
});

test('dev target: needs ALLOW_DEV_TARGET, DEV_BRANCH_ID, a direct URL, and must differ from the test endpoint', () => {
  const base = { DATABASE_URL_TEST: FAKE_TEST, DATABASE_URL_DIRECT: FAKE_DEV, DATABASE_URL: FAKE_DEV_POOLED };
  withEnv({ ...base, ALLOW_DEV_TARGET: undefined, DEV_BRANCH_ID: 'br-x' }, () =>
    assert.throws(() => resolveTarget('dev'), /ALLOW_DEV_TARGET/));
  withEnv({ ...base, ALLOW_DEV_TARGET: 'true', DEV_BRANCH_ID: '' }, () =>
    assert.throws(() => resolveTarget('dev'), /DEV_BRANCH_ID/));
  withEnv({ ...base, ALLOW_DEV_TARGET: 'true', DEV_BRANCH_ID: 'br-x', DATABASE_URL_DIRECT: FAKE_DEV_POOLED }, () =>
    assert.throws(() => resolveTarget('dev'), /non-pooled/));
  withEnv({ ...base, ALLOW_DEV_TARGET: 'true', DEV_BRANCH_ID: 'br-x', DATABASE_URL_DIRECT: FAKE_TEST, DATABASE_URL: FAKE_DEV_POOLED }, () =>
    assert.throws(() => resolveTarget('dev'), /separate|same endpoint/));
  withEnv({ ...base, ALLOW_DEV_TARGET: 'true', DEV_BRANCH_ID: 'br-x' }, () =>
    assert.equal(resolveTarget('dev').name, 'dev'));
});

test('test target refuses a pooled URL and any URL equal to the dev endpoint', () => {
  withEnv({ DATABASE_URL_TEST: FAKE_DEV_POOLED, DATABASE_URL_DIRECT: FAKE_DEV, DATABASE_URL: FAKE_DEV_POOLED }, () =>
    assert.throws(() => resolveTarget('test'), /non-pooled/));
  withEnv({ DATABASE_URL_TEST: FAKE_DEV, DATABASE_URL_DIRECT: FAKE_DEV, DATABASE_URL: FAKE_DEV_POOLED }, () =>
    assert.throws(() => resolveTarget('test'), /same endpoint/));
});

test('branch pin: verified against neon.branch_id; mismatch and missing-when-required are refused', async () => {
  const q = (branch: string | null) => ({ query: async () => ({ rows: [{ branch }] }) });
  await withEnv({ TEST_BRANCH_ID: 'br-ok' }, async () => {
    await assertBranchPin(q('br-ok'), 'test');
    await assert.rejects(assertBranchPin(q('br-other'), 'test'), /does not match TEST_BRANCH_ID/);
    await assert.rejects(assertBranchPin(q(null), 'test'), /does not match/);
  });
  await withEnv({ TEST_BRANCH_ID: undefined }, async () => {
    await assertBranchPin(q('anything'), 'test');                                  // optional for plain tests
    await assert.rejects(assertBranchPin(q('anything'), 'test', { required: true }), /not set/);
    assert.throws(() => requirePinConfigured('test'), /TEST_BRANCH_ID/);
  });
  await withEnv({ DEV_BRANCH_ID: undefined }, async () => {
    await assert.rejects(assertBranchPin(q('x'), 'dev'), /DEV_BRANCH_ID is not set/);
  });
});

test('targetFromArgv defaults to test and reads --target=', () => {
  assert.equal(targetFromArgv(['node', 'x.mjs']), 'test');
  assert.equal(targetFromArgv(['node', 'x.mjs', '--target=dev']), 'dev');
});

// ---- the real command-line tools, run as child processes, must refuse without connecting ----
function run(script: string, args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: backendDir, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

test('CLI: seed refuses without ALLOW_SEED, and without a pinned branch even with ALLOW_SEED', () => {
  const a = run('db/seed.mjs', [], { ALLOW_SEED: '', TEST_BRANCH_ID: 'br-x' });
  assert.notEqual(a.code, 0);
  assert.match(a.out, /ALLOW_SEED/);
  const b = run('db/seed.mjs', [], { ALLOW_SEED: 'true', TEST_BRANCH_ID: '' });
  assert.notEqual(b.code, 0);
  assert.match(b.out, /TEST_BRANCH_ID must be set/);
  assert.doesNotMatch(a.out + b.out, /postgres(ql)?:\/\//i);
});

test('CLI: reset refuses without ALLOW_RESET/--yes, and without a pinned branch', () => {
  assert.notEqual(run('db/reset.mjs', [], { ALLOW_RESET: 'true', TEST_BRANCH_ID: 'br-x' }).code, 0);   // no --yes
  const r = run('db/reset.mjs', ['--yes'], { ALLOW_RESET: 'true', TEST_BRANCH_ID: '' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /TEST_BRANCH_ID must be set/);
});

test('CLI: migrate/inspect refuse --target=dev without the gates and refuse any other target name', () => {
  for (const script of ['db/migrate.mjs', 'db/inspect.mjs']) {
    const noGate = run(script, ['--target=dev'], { ALLOW_DEV_TARGET: '', DEV_BRANCH_ID: '' });
    assert.notEqual(noGate.code, 0, script);
    assert.match(noGate.out, /ALLOW_DEV_TARGET/);
    const noPin = run(script, ['--target=dev'], { ALLOW_DEV_TARGET: 'true', DEV_BRANCH_ID: '' });
    assert.notEqual(noPin.code, 0);
    assert.match(noPin.out, /DEV_BRANCH_ID/);
    const prod = run(script, ['--target=production'], { ALLOW_DEV_TARGET: 'true', DEV_BRANCH_ID: 'br-x' });
    assert.notEqual(prod.code, 0);
    assert.match(prod.out, /Unknown target/);
    assert.doesNotMatch(noGate.out + noPin.out + prod.out, /postgres(ql)?:\/\//i);
  }
});
