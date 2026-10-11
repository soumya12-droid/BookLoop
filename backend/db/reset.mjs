// DESTRUCTIVE: drops and recreates the public schema of the TEST branch only.
// Requires BOTH ALLOW_RESET=true and the --yes flag. Target is DATABASE_URL_TEST (see lib/env.mjs).
import { connectTest } from './lib/env.mjs';

if (process.env.ALLOW_RESET !== 'true' || !process.argv.includes('--yes')) {
  console.error('Refusing: set ALLOW_RESET=true and pass --yes to reset the TEST branch.');
  process.exit(1);
}
// The expected Neon branch id must be pinned (TEST_BRANCH_ID) and is verified before DROP SCHEMA.
const client = await connectTest({ requirePin: true });
try {
  await client.query('DROP SCHEMA public CASCADE');
  await client.query('CREATE SCHEMA public');
  console.log('[reset] public schema recreated on the TEST branch.');
} finally {
  await client.end();
}
