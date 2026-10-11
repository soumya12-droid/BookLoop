// Prints the live schema (tables, constraints, indexes, triggers, views) from the catalogs.
// Read-only. Pass --write to also save the output to docs/SCHEMA_INSPECTION.md.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { connectTarget, targetFromArgv, backendDir } from './lib/env.mjs';

const client = await connectTarget(targetFromArgv()); // read-only; --target=dev follows the same gates as migrate
const out = [];
const say = (s = '') => out.push(s);

try {
  const q = async (sql) => (await client.query(sql)).rows;

  say('# Schema inspection (generated, read-only catalog queries)');
  say('');
  const ver = await q('SELECT version() AS v');
  say(`PostgreSQL: ${ver[0].v}`);
  const ext = await q(`SELECT extname, extversion FROM pg_extension ORDER BY 1`);
  say(`Extensions: ${ext.map((e) => `${e.extname} ${e.extversion}`).join(', ')}`);
  const mig = await q('SELECT version, name, applied_at FROM schema_migrations ORDER BY version');
  say('');
  say('## Applied migrations');
  mig.forEach((m) => say(`- ${m.version}  ${m.name}`));

  say('');
  say('## Tables and row counts');
  const tables = await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                          WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1`);
  for (const t of tables) {
    const n = (await q(`SELECT count(*)::int AS n FROM "${t.relname}"`))[0].n;
    say(`- ${t.relname}: ${n}`);
  }

  say('');
  say('## Constraints');
  const cons = await q(`SELECT conrelid::regclass::text AS tbl, conname,
        CASE contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'f' THEN 'FOREIGN KEY' WHEN 'u' THEN 'UNIQUE'
                     WHEN 'c' THEN 'CHECK' ELSE contype::text END AS kind,
        pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 3, 2`);
  let last = '';
  for (const c of cons) {
    if (c.tbl !== last) { say(''); say(`### ${c.tbl}`); last = c.tbl; }
    say(`- [${c.kind}] ${c.conname}: ${c.def}`);
  }

  say('');
  say('## Indexes');
  const idx = await q(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1, 2`);
  last = '';
  for (const i of idx) {
    if (i.tablename !== last) { say(''); say(`### ${i.tablename}`); last = i.tablename; }
    say(`- ${i.indexname}: ${i.indexdef}`);
  }

  say('');
  say('## Triggers');
  const trg = await q(`SELECT tgrelid::regclass::text AS tbl, tgname, tgdeferrable, tginitdeferred,
        pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`);
  for (const t of trg) say(`- ${t.tbl}.${t.tgname}${t.tgdeferrable ? ' [DEFERRABLE' + (t.tginitdeferred ? ' INITIALLY DEFERRED' : '') + ']' : ''}`);

  say('');
  say('## Views');
  const views = await q(`SELECT viewname FROM pg_views WHERE schemaname='public' ORDER BY 1`);
  views.forEach((v) => say(`- ${v.viewname}`));
} finally {
  await client.end();
}

const text = out.join('\n');
console.log(text);
if (process.argv.includes('--write')) {
  const file = path.resolve(backendDir, '..', 'docs', 'SCHEMA_INSPECTION.md');
  writeFileSync(file, text + '\n');
  console.log(`\n[written] ${file}`);
}
