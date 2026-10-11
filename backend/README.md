# BookLoop backend

Node 22+ (TypeScript runs natively via type stripping; there is no build step), Express 5, PostgreSQL
(Neon) through `pg` with explicit parameterised SQL.

```
backend/
  db/            migrations (0001-0009), seed, migration runner, inspection, DB integrity tests
  src/
    config/      typed environment configuration
    db/          pool + withTransaction (one client per transaction)
    http/        auth (JWT), validation (zod), error model and middleware
    repositories/ read-only queries shaped for the API
    routes/      thin route modules (auth, catalogue, lending/admin)
    services/    lending rules and locking, auth, catalogue writes
    app.ts       createApp({ pool, config })      server.ts  process entry point
  tests/         service, concurrency, HTTP and pooled-endpoint suites
```

Documentation: `../docs/API.md` (endpoints), `../docs/TESTING.md` (suites), `../docs/ENVIRONMENTS.md`
(**read first**: test vs dev targets and the safety guards), `../docs/PROPOSED_SCHEMA_V1.md`
(schema, triggers, lock protocol), `../docs/SCHEMA_INSPECTION.md`, `../docs/bookloop_schema.dbml`.

## Setup (Windows PowerShell or any shell)

```bash
cd backend
npm install
copy .env.example .env      # then edit .env (PowerShell: Copy-Item .env.example .env)
```

Generate a signing secret and put it in `.env` as `JWT_SECRET` (never commit `.env`):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Run the API

The only migrated database today is the **test branch**, so for local development:

```bash
npm run start:test-branch
```

This uses `DATABASE_URL_TEST` through the same guard as every other tool and prints no connection
details. `npm start` uses `DATABASE_URL` (your dev branch) and requires that branch to be migrated first.

The server binds to `127.0.0.1` unless `HOST` is set, and refuses to start if the target database has
not been migrated (it prints which problem, never a connection detail).

Smoke check: `curl http://127.0.0.1:4000/api/health` → `{"status":"ok"}`.

Pin the test branch once (`npm run db:whoami`, then `TEST_BRANCH_ID=br-…` in `.env`); seed and reset
refuse to run without it. Preparing the dev branch is a separate, gated procedure: see
`../docs/ENVIRONMENTS.md`.

## Database tooling (test branch only)

```bash
npm run db:migrate      # apply migrations (checksummed, forward-only)
npm run db:inspect      # print the live schema
npm run db:test         # Phase 1 integrity suite
# ALLOW_SEED=true required; truncates the test branch's BookLoop tables:
#   PowerShell:  $env:ALLOW_SEED='true'; npm run db:seed
```

## Tests

See `../docs/TESTING.md`. Short version: `npm run typecheck`, then `npm run test:all` (sequential, needs
`DATABASE_URL_TEST`). Never run two database suites at once.

## Security notes

- Secrets only in environment variables; `.env` is git-ignored; `.env.example` holds placeholders.
- Passwords: bcrypt. Tokens: HS256 JWT, user re-read from the database on every request.
- Admin accounts are promoted by an operator in the database; there is no endpoint for it (`docs/API.md`).
