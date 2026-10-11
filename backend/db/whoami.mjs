// Read-only: prints identifying server settings of the TEST target so the owner can compare them
// with the Neon console (project / branch / endpoint). Never connects to any other database.
import { connectTest } from './lib/env.mjs';

const c = await connectTest();
try {
  const r = await c.query(
    `SELECT name, setting FROM pg_settings WHERE name LIKE 'neon.%' AND name IN
       ('neon.project_id','neon.endpoint_id','neon.timeline_id','neon.tenant_id','neon.branch_id','neon.compute_id')
     ORDER BY name`);
  if (r.rows.length === 0) console.log('No neon.* identity settings are exposed by this server.');
  console.table(r.rows);
  const d = await c.query(`SELECT current_database() AS db, current_user AS role, inet_server_port() AS port`);
  console.table(d.rows);
} finally {
  await c.end();
}
