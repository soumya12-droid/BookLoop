# Testing guide

Every suite that touches a database connects to the **Neon test branch only**, through one guard
(`backend/db/lib/env.mjs`): it reads `DATABASE_URL_TEST`, rejects a pooled URL, refuses if the endpoint
equals the dev endpoint, and verifies the branch id when `TEST_BRANCH_ID` is set. Nothing in the
repository connects to the dev endpoint except `db:migrate`/`db:inspect` with the explicit
`--target=dev` gates. See `docs/ENVIRONMENTS.md`.

**Run suites one at a time.** Fixtures are namespaced (`p2-…@phase2.test`, `P2 Book …`, `P2 Author …`)
and each suite removes leftovers of that namespace when it starts and ends, so two suites running in
parallel would delete each other's data. `npm run test:all` is sequential.

| Suite | Command (from `backend/`) | DB? | What it proves |
|---|---|---|---|
| Type-check | `npm run typecheck` | no | TypeScript compiles (strict). |
| Tooling guards | `npm run test:guards` | **no** | seed/reset/migrate/inspect refuse, *before connecting*, without their gates and pins; no target can name production. |
| Phase 1 integrity | `npm run db:test` | test branch | 46 SQL-level constraint/trigger/view tests (DB-01…DB-45), each in a rolled-back transaction. |
| T-G commit | `npm run test:tg` | test branch | Real COMMITs: loan ⇔ request FULFILLED, both directions. |
| Lending service | `npm run test:service` | test branch | Rules, authorisation, state machine, atomic rollback. |
| Hardening | `npm run test:hardening` | test branch (read-only) | Login timing parity, configuration validation, startup schema check. |
| HTTP API | `npm run test:api` | test branch | Auth, authorisation, lending over HTTP, validation, error mapping, deactivation effects, headers, health. |
| Pooled endpoint | `npm run test:pooled` | test branch | The data path through Neon's PgBouncer (transaction mode). |
| Concurrency | `npm run test:concurrency` | test branch | Real racing connections. ~13 min at ~260 ms round trip. |
| Everything | `npm run test:all` | test branch | All of the above, sequentially. |

The seed (`npm run db:seed`) is **not** required by any suite and is never modified by them; it only
provides realistic demo data and the "seed data readable" API test.

## B4 (six-way approval race) and `RESOURCE_BUSY`

Six borrowers' requests for one copy are approved at the same moment. The invariant under test is
**never more than one reservation**, and it always holds (exactly one `APPROVED` row).

- **Original B4** required every losing call to return `COPY_RESERVED`. It failed in the first run
  because some losers returned `RESOURCE_BUSY` instead.
- **Cause (measured):** the copy row lock serialises the six transactions. At ≈ 263 ms per round trip
  one approval takes ≈ 2.1 s and the queue drains at ≈ 0.8 s per loser. A caller starts waiting at
  ≈ 1.4 s and its `lock_timeout` is 3 s, so the fifth waiter's deadline (≈ 4.4 s) passes just before
  its turn (≈ 4.5 s) and PostgreSQL raises 55P03. Deterministic; not a deadlock
  (`pg_stat_database.deadlocks` stayed 0, no 40P01) and not a harness timeout.
- **B4 now** (default 3 s) allows `RESOURCE_BUSY` among the losers because that is the specified,
  retryable outcome of a lock timeout (A8 asserts it). It still asserts: at most one success, approved
  rows equal successes, every loser is `COPY_RESERVED` or `RESOURCE_BUSY`.
- **B4b** repeats the race with a 60 s timeout and asserts the strict form: exactly one `OK`, five
  `COPY_RESERVED`, zero `RESOURCE_BUSY`.

## The lock-timeout HTTP test and its timing bound

`SQLSTATE 55P03 … maps to a retryable 409 RESOURCE_BUSY` holds the copy lock from a second connection
and calls `POST /api/requests/:id/approve` on an app configured with `LOCK_TIMEOUT_MS=400`.

The *correctness* assertions are unchanged and strict: status 409, code `RESOURCE_BUSY`,
`Retry-After: 1`, no PostgreSQL text in the body, and the request still `PENDING` afterwards.

The *timing* assertion was revisited after an investigation (it had briefly been a flat "< 20 s"):

| Measurement (≈ 263 ms round trip, warm pool) | Time |
|---|---|
| Uncontended approval over HTTP (11 statements) | 2.8 – 3.0 s |
| Lock-timeout path (aborts earlier, fewer statements, + 0.4 s wait) | 2.0 – 2.3 s |
| Same, but pooled connections idle > 10 s were evicted (TLS + SCRAM reconnect ≈ 2.2 s) | 4.1 – 4.5 s |

So the original 5.3 s sample was network/TLS reconnect overhead on a cold pool, not a hang and not a
performance defect. Absolute thresholds are meaningless across networks, so the bound is **relative**:

- `waited ≥ 350 ms`: the call really waited out the 400 ms lock timeout (and returned while the other
  connection still held the lock, because it is released only afterwards);
- `waited ≤ uncontended baseline measured immediately before on the same app and pool + 400 ms + 1.5 s`.

A hang, or a wait for the lock holder, exceeds this bound by a wide margin on any network; a slow
network scales the baseline and the contended call together.

**Pool warmth is controlled, not tolerated.** The lock holder takes one pooled connection and the HTTP
call needs another. In one full run the pool held a single idle connection, so the contended call
paid a fresh TLS + SCRAM connect (≈ 2 s) that the baseline had not (`contended 5638 ms` vs
`baseline 3588 ms`, failing the bound by 0.15 s). That was an artefact of the experiment, so the test
now opens and releases three connections immediately before measuring. The bound itself was not
loosened.
