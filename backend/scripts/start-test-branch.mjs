// Starts the API against the verified TEST branch (the only migrated database right now).
// Uses the same guard as every other tool: DATABASE_URL_TEST only, never the dev endpoint, and the
// branch id is verified first when TEST_BRANCH_ID is set. Requires JWT_SECRET (>= 32 characters).
// Prints no connection details. The server binds to 127.0.0.1 unless HOST is set.
import { connectTest, loadEnv, testTarget } from '../db/lib/env.mjs';

loadEnv();
const probe = await connectTest();     // verifies reachability and the TEST_BRANCH_ID pin, then closes
await probe.end();

process.env.DATABASE_URL = testTarget().url;
await import('../src/server.ts');
