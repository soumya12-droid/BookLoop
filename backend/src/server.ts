// Process entry point: loads backend/.env, validates configuration and the database schema,
// then starts the HTTP server on the configured interface (loopback unless HOST says otherwise).
import { createApp } from './app.ts';
import { loadConfig, loadDotEnv } from './config/env.ts';
import { createPool } from './db/pool.ts';
import { assertSchemaReady } from './db/ready.ts';

loadDotEnv();
const config = loadConfig();
const pool = createPool(config.databaseUrl);

try {
  await assertSchemaReady(pool);
} catch (err) {
  // The message names the problem, never a connection detail.
  console.error(`[startup] ${(err as Error).message}`);
  await pool.end().catch(() => {});
  process.exit(1);
}

const app = createApp({ pool, config });

const server = app.listen(config.port, config.host, () => {
  console.log(`BookLoop API listening on ${config.host}:${config.port} (${config.nodeEnv})`);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
