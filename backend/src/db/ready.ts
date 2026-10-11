// Startup safety: refuse to serve traffic against a database that has not been migrated.
// (The dev branch is intentionally unmigrated until the owner runs the migrations on it.)
export const REQUIRED_MIGRATION = '0009';

interface Queryable {
  query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
}

export async function assertSchemaReady(db: Queryable): Promise<void> {
  const t = await db.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`);
  if (t.rows[0]?.present !== true) {
    throw new Error(
      'The database schema is not migrated (table schema_migrations is missing). ' +
      'Run the migrations on this database before starting the API.');
  }
  const v = await db.query(`SELECT max(version) AS latest FROM schema_migrations`);
  const latest = (v.rows[0]?.latest as string | null | undefined) ?? null;
  if (latest === null || latest < REQUIRED_MIGRATION) {
    throw new Error(
      `The database schema is behind: latest applied migration is ${latest ?? 'none'}, ` +
      `${REQUIRED_MIGRATION} is required.`);
  }
}
