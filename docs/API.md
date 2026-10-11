# BookLoop HTTP API (Phase 3)

Express 5 + TypeScript on the existing PostgreSQL schema. Routes are thin: every lending state change
calls `backend/src/services/lending.ts` (copy → request → loan lock order, compare-and-set updates,
deferred T-G commit check). No schema or migration was changed for the API.

Base path: `/api`. All bodies are JSON. All responses carry `X-Request-Id` and `Cache-Control: no-store`.

## Conventions

**Success:** `{ "data": … }`; lists add `"page": { "limit", "offset", "total" }`.
**Error:** `{ "error": { "code", "message", "details"?, "requestId" } }`.

**Authentication:** `Authorization: Bearer <token>` (HS256 JWT, 1 h by default, issuer `bookloop`,
audience `bookloop-api`). After verifying the signature, expiry, issuer, audience and algorithm, the
user row is **re-read from the database on every request**, so a deactivated member is rejected
immediately. Identity is never taken from a body, query or path parameter.

**Concealment policy:** a request, loan or unlisted copy you are not a party to is answered `404`,
indistinguishable from "does not exist". A party who merely lacks the right gets `403`.

**Pagination:** `?limit=1..100` (default 20) `&offset=0..` (default 0). Out-of-range values are `400`.

### Status codes

| Status | Used for |
|---|---|
| 200 / 201 | Success / created |
| 400 | Malformed JSON, failed validation, malformed id, unknown body field |
| 401 | Missing/invalid/expired token, unknown or deactivated account, bad credentials |
| 403 | Authenticated, a party, but not allowed (e.g. requester tries to approve) |
| 404 | Not found, or concealed by the authorization policy |
| 409 | State conflict: unavailable copy, duplicate, illegal transition, lock timeout |
| 413 | Body larger than 32 KB |
| 422 | Well-formed but violates a rule (own copy, unknown genre, check constraint) |
| 429 | Rate limit |
| 500 | Unexpected error; generic body, details only in the server log (redacted) |
| 503 | `/api/health` when the database is unreachable |

### Database error mapping

| SQLSTATE | HTTP | Code | Notes |
|---|---|---|---|
| 23505 | 409 | by constraint: `COPY_RESERVED`, `DUPLICATE_OPEN_REQUEST`, `COPY_ON_LOAN`, `ALREADY_FULFILLED`, `ALREADY_REVIEWED`, `EMAIL_TAKEN`, `ISBN_EXISTS`; else `CONFLICT` | |
| **23001** | 409 | `IN_USE` | `ON DELETE RESTRICT` (history is never deleted) |
| 23503 | 422 | `INVALID_REFERENCE` | composite FK / missing parent |
| 23514 | 422 | `CONSTRAINT_VIOLATION` | |
| **55P03** | 409 | `RESOURCE_BUSY` | lock timeout; header `Retry-After: 1`; **safe to retry** |
| 40P01 / 40001 | 409 | `RETRY` | after one automatic retry; `Retry-After: 1` |
| `LD001…LD012` | 409/422 | see `src/services/errors.ts` | guard triggers (defence in depth) |

### Error codes returned by the lending rules

`COPY_UNAVAILABLE` (`details.reason`: `UNLISTED`, `OWNER_DEACTIVATED`, `ON_LOAN`, `RESERVED`),
`OVERDUE_LOANS_BLOCK` (`details.loans[]`), `SELF_REQUEST`, `DUPLICATE_OPEN_REQUEST`, `INVALID_STATE`,
`COPY_RESERVED`, `COPY_ON_LOAN`, `COPY_UNLISTED`, `REQUESTER_DEACTIVATED`, `BORROWER_DEACTIVATED`,
`ALREADY_FULFILLED`, `ALREADY_RETURNED`, `LOAN_NOT_RETURNED`, `ALREADY_REVIEWED`,
`ALREADY_DEACTIVATED`, `SELF_DEACTIVATION`, `ACCOUNT_DEACTIVATED`.

## Endpoints

"Auth" = bearer token required. Unless stated, authorisation is evaluated by the service **after**
the row locks are taken.

### Authentication and profile

| Method & path | Auth | Authorization / behaviour |
|---|---|---|
| `POST /api/auth/register` | none | Rate limited. Role is always `MEMBER`; a `role` field is a 400. |
| `POST /api/auth/login` | none | Rate limited (failures only). Generic `401 INVALID_CREDENTIALS` for unknown email, wrong password **and** deactivated account. |
| `GET /api/auth/me` | yes | Own profile. |
| `PATCH /api/users/me` | yes | Own `displayName`, `defaultPickupLocation`, `contactInfo` only. Email/role/password are not changeable here (400). |

```http
POST /api/auth/register
{ "email": "a@campus.test", "password": "correct-horse-battery", "displayName": "Asha", "contactInfo": "Hostel A 101" }

201 { "data": { "user": { "id": "…", "email": "a@campus.test", "displayName": "Asha", "role": "MEMBER",
                          "defaultPickupLocation": null, "contactInfo": "Hostel A 101", "createdAt": "…" },
                "token": "eyJ…", "tokenType": "Bearer", "expiresIn": 3600 } }
```

Passwords: 10–72 bytes, hashed with bcrypt (cost 12 by default). Emails are trimmed and lower-cased;
the column is `citext`, so uniqueness is case-insensitive.

### Catalogue and discovery

Read-only browsing is **public**: the six `GET` routes marked *public* below work without a token.
Everything that creates or changes data, and everything about "me", needs a token.

Public routes use optional authentication. With no `Authorization` header the caller is anonymous.
If a header **is** sent it is fully verified exactly as on protected routes: a bad, expired or
deactivated-account token is `401`, never silently treated as anonymous. Signed-in responses are
unchanged.

What anonymous callers do **not** receive: member ids (`owner` is `{ displayName }`), `pickupLocation`
and `notes` (always `null`), loan ids on reviews, emails, contact details, unlisted copies. Contact
details remain visible only to the counterparty of an approved request or active loan.

Anonymous reads are rate limited per client address (`RATE_LIMIT_PUBLIC_READ_MAX`, default 600 per
window); over the cap is `429 RATE_LIMITED` with `Retry-After`. Signed-in requests are not counted.

| Method & path | Notes |
|---|---|
| `GET /api/genres` *(public)* | Controlled list. |
| `GET /api/books?q=&genreId=&availableOnly=&limit=&offset=` *(public)* | `ILIKE` over title, author name, genre name; exact ISBN-13. `%`, `_`, `\` in `q` are literal. `availableOnly` is derived from `available_copies`. Ordered by title. |
| `GET /api/books/:bookId` *(public)* | Book with authors, genres, `availableCopies`, `reviewCount`, `averageRating`. |
| `POST /api/books` | Any member. Body: `title`, `isbn?` (ISBN-13, checksum validated), `edition?`, `publisher?`, `publicationYear?`, `description?`, `authors?` (names), `genreIds?`. Duplicate ISBN → `409 ISBN_EXISTS`. |
| `GET /api/books/:bookId/copies` *(public)* | Listed copies of active owners, plus the viewer's own, plus all for admins. `available` is derived. Signed-in: owner `{id, displayName}`; anonymous: `{displayName}` only, no pickup place or notes. |
| `POST /api/books/:bookId/copies` | Creates a copy owned by the caller. `condition?` ∈ `NEW LIKE_NEW GOOD FAIR POOR`, `pickupLocation?`, `notes?`. |
| `GET /api/copies/:copyId` *(public)* | 404 for an unlisted copy unless owner/admin. Same anonymous reduction as above. |
| `PATCH /api/copies/:copyId` | `{ "isListed": boolean }`, owner only (admins get 403). Refused (409) while reserved or on loan. |
| `GET /api/users/me/copies` | The caller's own copies, listed or not. |
| `GET /api/books/:bookId/reviews` *(public)* | Paginated; reviewer shown by display name only. `loanId` is included for signed-in callers only. |

### Requests and lending

| Method & path | Who | Result |
|---|---|---|
| `POST /api/copies/:copyId/requests` `{ "message"? }` | any active member except the owner | 201 request. Only for an **available** copy (no waitlist). Blocked while the caller has an overdue loan. |
| `GET /api/requests?role=requester\|owner\|all&status=` | caller (`all`: admin) | Own requests (default) or incoming requests for own copies. |
| `GET /api/requests/:requestId` | requester, owner, admin | Others: 404. |
| `POST /api/requests/:requestId/approve` | **owner only** | `PENDING → APPROVED`. Reserves the copy. |
| `POST /api/requests/:requestId/reject` | owner only | `PENDING → REJECTED`. |
| `POST /api/requests/:requestId/cancel` | requester (PENDING/APPROVED), owner (APPROVED only: no-show), admin | `→ CANCELLED`; releases the reservation atomically. No automatic expiry. |
| `POST /api/requests/:requestId/handoff` `{ "days"? }` | owner; admin override | 201 loan. `days` integer 1–60, default 14; due at end of that day (Asia/Kolkata). |
| `GET /api/loans?role=borrower\|lender\|all&status=active\|returned\|overdue` | caller (`all`: admin) | History. `isOverdue` is derived. |
| `GET /api/loans/:loanId` | borrower, lender, admin | Others: 404. |
| `POST /api/loans/:loanId/return` | lender (owner); admin override | Borrower gets 403. Second call: `409 ALREADY_RETURNED`. |
| `POST /api/loans/:loanId/review` `{ "rating": 1-5, "comment"? }` | the borrower of a **returned** loan | 201. One per loan (also `UNIQUE(loan_id)` in the database). |

`PATCH /api/loans/:loanId/due-date` is **not implemented**: the approved design makes `due_at`
immutable (trigger T-D) and renewals are out of scope. The path returns `404`.

```http
POST /api/requests/9f…/handoff   { "days": 7 }

201 { "data": { "id": "…", "requestId": "9f…", "copy": { "id": "…", "bookId": "…", "bookTitle": "…" },
                "borrower": { "id": "…", "displayName": "…" }, "lender": { "id": "…", "displayName": "…" },
                "borrowedAt": "…", "dueAt": "…", "returnedAt": null, "isOverdue": false,
                "counterpartyContact": "Hostel A 101" } }
```

```http
POST /api/copies/…/requests   (borrower has an overdue loan)

409 { "error": { "code": "OVERDUE_LOANS_BLOCK",
                 "message": "You have overdue loans. Return them (ask the lender to record the return) before requesting more books.",
                 "details": { "loans": [ { "loanId": "…", "dueAt": "…", "lenderId": "…" } ] }, "requestId": "…" } }
```

### Contact information (privacy)

`counterpartyContact` is the *other* party's `contactInfo`. It is non-null only while a request is
`APPROVED` or its loan is not yet returned, only for the two parties (and administrators). It never
appears in catalogue, copy or review responses.

### Administration

| Method & path | Who |
|---|---|
| `POST /api/admin/users/:userId/deactivate` | administrator. Cancels the user's own open requests; loans and history are untouched; the user cannot authenticate afterwards. Self-deactivation is refused. |

Catalogue editing/merging is not implemented (no supporting service); it is a documented limitation.

### Health

`GET /api/health` (no auth) → `200 {"status":"ok"}` or `503 {"status":"unavailable"}`. No other fields.

## Administrator bootstrap (no public path)

There is deliberately no endpoint that grants admin rights. An operator promotes an account directly
in the database, with a connection they already hold:

```sql
UPDATE users SET role = 'ADMIN' WHERE email = 'person@example.edu' AND deactivated_at IS NULL;
```

The seed script creates `admin@bookloop.test` on the **test** branch only, with a development-only
password documented in `backend/db/seed/demo.mjs`. It is the one account with a publicly known
password; this is why the API binds to loopback by default and why seeding is limited to the test branch.

Administrator changes (promotion, demotion, deactivation) take effect on the very next request,
because the role and active flag are read from the database on every call. A deactivated
administrator's still-valid token is rejected with 401 on every route.

## Environment variables (names only)

`DATABASE_URL`, `DATABASE_URL_DIRECT`, `DATABASE_URL_TEST`, `TEST_BRANCH_ID`, `DEV_BRANCH_ID`,
`JWT_SECRET` (required, ≥ 32 chars), `PORT`, `HOST` (default `127.0.0.1`), `NODE_ENV`,
`JWT_TTL_SECONDS`, `BCRYPT_COST`, `LOCK_TIMEOUT_MS`, `CORS_ORIGINS`, `TRUST_PROXY`,
`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_LOGIN_MAX`, `RATE_LIMIT_REGISTER_MAX`, `RATE_LIMIT_PUBLIC_READ_MAX`.
Command-line gates (not stored): `ALLOW_SEED`, `ALLOW_RESET`, `ALLOW_DEV_TARGET`.
See `backend/.env.example` and `docs/ENVIRONMENTS.md`.

### Serving the web app from another origin (production checklist)

- **`CORS_ORIGINS`** — comma-separated list of the exact origins of the web app, e.g.
  `https://bookloop.example`. Unset means *no* browser origin is allowed (the safe default). No
  wildcard is used and credentials/cookies are not involved: the token travels in the
  `Authorization` header, which makes browsers send a preflight that the API answers.
- **`VITE_API_BASE_URL`** (frontend, build time) — the public address of the API. In development the
  Vite dev server proxies `/api`, so CORS is not needed there; a production build calls this address
  directly and therefore needs the matching `CORS_ORIGINS` entry.
- **`TRUST_PROXY`** — leave `false` when the API is reached directly. Behind a reverse proxy set it to
  the **number of proxy hops** (e.g. `1`), never `true`: with `true` a client can send its own
  `X-Forwarded-For` and every per-IP rate limit (login, registration, anonymous catalogue reads)
  can be dodged. With the wrong value all visitors share the proxy's address and one bucket.
- **Rate-limit counters are in process memory.** One API instance is assumed; several instances each
  keep their own counters.
- Always serve over HTTPS and keep `HOST` on loopback unless a trusted proxy fronts the process.

## Input hygiene

NUL characters in any query/body string are rejected with `400 VALIDATION_ERROR` (PostgreSQL text
cannot store them). Client errors raised by the HTTP stack (unsupported `Content-Encoding` → `415
UNSUPPORTED_MEDIA_TYPE`, corrupt compressed body → `400 BAD_REQUEST`) are 4xx, never 500.

## Known limitations, and whether they matter for the prototype

| Limitation | Assessment |
|---|---|
| Rate limiting is in-process memory (resets on restart, per instance) | **Acceptable** for one process. Needs a shared store (e.g. Redis) before running several instances. |
| Registration answers `409 EMAIL_TAKEN` (account-existence disclosure) | **Acceptable**: the user needs the feedback and there is no email-based flow to send a neutral message through. Login does not disclose, and its timing is constant (see `tests/hardening.test.ts`). The registration limiter bounds enumeration. |
| No password reset, email verification, refresh tokens or logout | **Acceptable / out of scope**: the PRD excludes email/SMS and "production-grade identity verification". Tokens last one hour (`JWT_TTL_SECONDS`); the client discards the token to log out, and server-side deactivation is immediate. Revisit before any public launch. |
| `RESOURCE_BUSY` is surfaced rather than retried server-side | **Acceptable and documented**: it is a 409 with `Retry-After: 1`, produced only when a lock wait exceeds `LOCK_TIMEOUT_MS`. The **frontend must retry once** (and show a neutral "busy, retrying" state). |
| No catalogue moderation or admin listing endpoints | **Deferred**: D-10 allows admin edit/merge but no requirement forces it for the prototype and no service exists; members can create entries, duplicates are possible. |
| No due-date changes / renewals | **By design** (T-D makes `due_at` immutable). |
| Authenticated write endpoints have no per-user rate limit | **Low risk** for a closed community; add a limiter before opening registration publicly. |
| Stored strings are returned unescaped | **Frontend duty**: render as text (React does by default); never `dangerouslySetInnerHTML`. |
| Accounts hashed at a different bcrypt cost than `BCRYPT_COST` (e.g. seed accounts) have slightly different login timing | **Acceptable**: only the unknown-email vs known-email difference matters and all API-created accounts use the configured cost. |
