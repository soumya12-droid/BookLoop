# Phase 3 audit: backend API readiness

Method: the actual source, tests and documentation were re-read (file timestamps checked for any
change not made during the phase), every dynamic SQL fragment was enumerated, suspected defects were
**reproduced before being fixed**, and the full suite was re-run sequentially against the test branch.

## Findings (ranked)

| # | Severity | Finding | Evidence | Status | Regression test |
|---|---|---|---|---|---|
| 1 | Medium | **NUL character in any query/body string produced `500`.** PostgreSQL text cannot hold U+0000; no validator rejected it. Any member could generate 500s and log noise at will. | Probe: `GET /api/books?q=a%00b` and `POST /api/books {"title":"a\u0000b"}` returned 500. | Fixed: `parse()` rejects NUL anywhere in the input (400 `VALIDATION_ERROR`). | `api.test.ts` "NUL characters … are 400, never 500" |
| 2 | Medium | **Login timing oracle.** The "unknown email" path compared against a bcrypt hash at cost 10 while real accounts use `BCRYPT_COST` (12), so unknown emails answered ~5x faster: 60 ms vs 309 ms measured. | Direct measurement of `bcrypt.compare` at both costs. | Fixed: dummy hash is generated at the configured cost, memoised and warmed at startup. | `hardening.test.ts` "unknown-email path performs a bcrypt comparison at the REAL cost" |
| 3 | Medium | **API bound to all interfaces.** With `start:test-branch` the seeded administrator (known development password) was reachable from the network. | `app.listen(port)` with no host. | Fixed: binds `127.0.0.1` unless `HOST` is set; documented. | `hardening.test.ts` config test; live check: listening address `127.0.0.1` |
| 4 | Medium | **No startup safety.** Starting against the (unmigrated) dev branch would serve traffic and fail at the first query with 500s. | Code inspection (`server.ts`). | Fixed: `assertSchemaReady` refuses to start, with a message that names the problem but no connection detail. | `hardening.test.ts` (passes on the migrated branch; refuses unmigrated / outdated) |
| 5 | Low | HTTP-stack client errors (unsupported or corrupt `Content-Encoding`) fell through to `500`. | Probe returned 500 for both. | Fixed: `415 UNSUPPORTED_MEDIA_TYPE` / `400 BAD_REQUEST`. | `api.test.ts` "HTTP-stack client errors … are 4xx" |
| 6 | Low | Destructive tooling relied only on a URL comparison; a mistyped `DATABASE_URL_TEST` pointing at an unrelated database would pass. | Design review of `db/lib/env.mjs`. | Fixed: `TEST_BRANCH_ID` pin verified against `neon.branch_id`; seed/reset *require* it and check it before connecting; the dev target is gated (`--target=dev`, `ALLOW_DEV_TARGET`, `DEV_BRANCH_ID`, direct URL, differs from test). No production target exists. | `guards.test.ts` (8 tests, no database connection) |
| 7 | Low | `POST /copies/:id/requests` for an unlisted / deactivated-owner copy answered 409, confirming that the copy exists (policy: 404). *Found and fixed earlier in Phase 3; re-verified.* | HTTP test failure at the time. | Fixed in the route with the same visibility rule as `GET`. | `api.test.ts` "requesting an unavailable copy …", "a deactivated owner's copies disappear" |
| 8 | Low | The lock-timeout HTTP test used a flat "< 20 s" ceiling. | Section C below. | Replaced by a relative bound with a controlled pool. | `api.test.ts` 55P03 test; `docs/TESTING.md` |

No Critical or High findings. No schema or migration change was required or made.

## Verified, no defect found

| Area | How it was verified |
|---|---|
| **SQL injection** | All values are bound parameters. The only interpolated fragments are fixed column names, fixed table fragments and numbered placeholders; `lock_timeout` is an integer from configuration. LIKE metacharacters are escaped; `' OR 1=1; --` returns an empty result. |
| **Authentication** | HS256 only; signature, expiry, issuer, audience and UUID subject verified; `alg=none`, wrong key, wrong audience, expired and unknown-subject tokens all 401 identically. |
| **Identity** | Taken only from the verified token; role and active flag re-read from the database on every request. Body/query `userId`, `role`, `id`, `email` are rejected by strict schemas. |
| **No privilege-escalation path** | `role` is not accepted at registration or profile update (400); there is no promotion endpoint; admin routes require the database role. Bootstrap is an operator SQL statement (`docs/API.md`). |
| **Admin and deactivation** | Promotion/demotion take effect on the next request; a deactivated administrator's token is 401 everywhere; members get 403 on every admin operation; unauthenticated 401. Deactivation cancels the user's own PENDING/APPROVED requests (attributed to the admin), preserves active loans (the lender can still close them), loans history and reviews, hides listings, leaves incoming requests as specified; an admin can resolve them. |
| **Authorization** | A matrix over approve / reject / cancel / handoff / return / review / listing / read, for owner, requester, stranger, admin and unauthenticated callers. Admins have **no** approve/reject/listing override (D-9). |
| **Contact privacy** | `counterpartyContact` appears only to the two parties (and admins) while a request is APPROVED or the loan is active; never in catalogue, copy or review responses. |
| **Concealment** | Strangers get 404 for requests, loans and unlisted copies; parties lacking the right get 403. |
| **Pagination / validation** | `limit` 1–100, `offset` ≤ 1 000 000, `q` ≤ 100 chars, body ≤ 32 KB, unknown fields rejected, malformed UUIDs 400. |
| **Error handling** | Unexpected errors are generic with a request id; the server log redacts URLs; PostgreSQL text never reaches the client. 23001 → 409 `IN_USE`, 55P03 → 409 `RESOURCE_BUSY` + `Retry-After`. |
| **Secrets** | No credentials in any file other than `.env`; the only matches are deliberate dummy URLs in tests. |

## C. The 5 s → 20 s → relative-bound timing change

- The first failure (`waited 5330 ms`, bound 5000) was **network/TLS overhead on a cold pool**, not a
  hang. Measured at ≈ 263 ms round trip: uncontended HTTP approval 2.8–3.0 s, lock-timeout path
  2.0–2.3 s (it executes fewer statements), and ≈ +2.2 s whenever pooled connections idle > 10 s must
  re-open (TLS + SCRAM). No request hung and no performance defect was exposed.
- A flat 20 s ceiling was too loose to mean anything, so it was replaced by a **relative** bound:
  `≥ 350 ms` (it really waited out `lock_timeout`) and `≤ uncontended baseline measured just before +
  400 ms + 1.5 s`. A hang or a wait for the lock holder blows through this on any network.
- In a later full run this bound failed by 0.15 s (`5638 ms` vs `3588 ms`). Cause: the test took the
  lock-holder connection from the same small pool, so the contended call opened a fresh connection the
  baseline did not. The experiment now pre-warms the pool; the bound was **not** loosened. Details in
  `docs/TESTING.md`.

## Requirement coverage gaps (not defects; not implemented, by instruction)

| Gap | Source | Note |
|---|---|---|
| `GET /api/analytics` | PRD FR-12 (P1) | The five analytics views exist in the database; a thin read endpoint is all that is missing. Needed before the analytics page, which the PRD schedules last. |
| Editing a copy's condition / pickup / notes | FR-03 | Only list/unlist is exposed. Add a small `PATCH` field set when the "My listings" form needs it. |
| Admin catalogue edit/merge | D-10 | No service exists; duplicates are possible. |
| Logout, refresh, password change/reset, email verification | outside the PRD scope | See the limitations assessment in `docs/API.md`. |

## Verdict

**Ready for frontend development.** Preconditions for the frontend team: set `JWT_SECRET`; develop
against `npm run start:test-branch` (the dev branch is not migrated and the server will refuse it);
retry once on 409 `RESOURCE_BUSY`; expect token expiry after 1 h (`JWT_TTL_SECONDS`); render all
returned strings as text; use `owner.id === me.id` to hide "request" on one's own copies.
