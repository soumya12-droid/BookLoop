# Environments and the safe database workflow

BookLoop has exactly two database targets that tooling can name, and none that can name production.

| Target | Variable | Used by | Allowed operations |
|---|---|---|---|
| **test** (default) | `DATABASE_URL_TEST` (direct, non-pooled) | every tool and every test suite | migrate, inspect, seed, reset, all tests |
| **dev** | `DATABASE_URL_DIRECT` (direct) | `db:migrate` and `db:inspect` **only**, with `--target=dev` | migrate, inspect (read-only). Never seed, reset or tests. |
| production | none | nothing | the repository has no way to name it |

The API server itself uses `DATABASE_URL` (the dev branch's **pooled** string) with `npm start`, or the
test branch with `npm run start:test-branch`.

> **State today:** only the test branch has been migrated. The dev branch is empty and `npm start`
> will refuse to run against it until it has been migrated (see step 4).

## The guards (what stops which mistake)

| Mistake | Guard | Where |
|---|---|---|
| `DATABASE_URL_TEST` accidentally set to the dev endpoint | Refuses when its endpoint+database equal `DATABASE_URL` or `DATABASE_URL_DIRECT` | `db/lib/env.mjs` |
| `DATABASE_URL_TEST` set to a wrong, unrelated database (e.g. production) | **Branch pin**: `TEST_BRANCH_ID` is compared with the server's `neon.branch_id`; mismatch refuses. Seed and reset *require* the pin; test suites verify it whenever it is set. | `assertBranchPin`, `tests/helpers.ts` |
| Running `seed`/`reset` by accident | `ALLOW_SEED=true` / `ALLOW_RESET=true` + `--yes`, **and** the pin must be configured *before* a connection is attempted | `seed.mjs`, `reset.mjs` |
| Migrating the wrong database | `--target=dev` additionally needs `ALLOW_DEV_TARGET=true`, a `DEV_BRANCH_ID` that matches the connected branch, a non-pooled URL, and an endpoint different from the test branch | `devTarget()` |
| Migrating a database that already holds other tables | The runner refuses unless `schema_migrations` exists or the database is empty; applied migrations are checksummed | `migrate.mjs` |
| Starting the API against an unmigrated/outdated database | `assertSchemaReady` exits with a clear message before listening | `src/db/ready.ts` |
| Exposing the API (and its seeded demo accounts) on the network | Binds `127.0.0.1` unless `HOST` is set | `src/config/env.ts` |
| Typing a target name like `production` | `Unknown target` error; only `test` and `dev` exist | `resolveTarget()` |

`tests/guards.test.ts` exercises all of these without opening a database connection.

**What the guards do not do.** They rely on environment variables and Neon's branch identity. Someone
who edits the scripts, or who puts a production connection string into `DATABASE_URL_TEST` *and* its
branch id into `TEST_BRANCH_ID`, defeats them. Defence in depth: never store a production connection
string in this repository's `.env`; give production its own Neon role/project; use a least-privilege
role for the running application.

## Workflow

### 1. One time: pin the test branch

```bash
npm run db:whoami                  # prints neon.branch_id of DATABASE_URL_TEST (no secrets)
```

Put that id in `backend/.env` as `TEST_BRANCH_ID=br-...`. From now on every suite verifies it and
seed/reset refuse to run without it.

### 2. Day to day: develop and test on the test branch

```bash
npm run typecheck
npm run test:all                   # sequential; never run two suites at once
npm run start:test-branch          # API on http://127.0.0.1:4000 against the test branch
```

### 3. Optional demo data (test branch only, destructive to BookLoop tables)

PowerShell:

```bash
$env:ALLOW_SEED='true'; npm run db:seed
```

### 4. Preparing the dev branch (when you decide to; not done yet)

1. In Neon, create or choose an **empty** branch for development. Note its id (`br-...`) from the console.
2. Set `DATABASE_URL_DIRECT` (direct string) and `DATABASE_URL` (pooled string) for that branch in `.env`.
3. Put the branch id in `.env` as `DEV_BRANCH_ID=br-...`.
4. Migrate, with the gate on the command line only (PowerShell):

   ```bash
   $env:ALLOW_DEV_TARGET='true'; npm run db:migrate -- --target=dev
   ```

5. Verify read-only: `$env:ALLOW_DEV_TARGET='true'; npm run db:inspect -- --target=dev`.
6. `npm start` now passes the schema check and uses `DATABASE_URL`.

Seed data is deliberately not available for the dev target. Create real accounts through the API and
promote an administrator with the SQL in `docs/API.md`.

### 5. Production

Out of scope for this repository. When it exists, treat it as a separate project: separate credentials,
migrations run by a deliberate, reviewed release step, and no destructive tooling pointed at it.
