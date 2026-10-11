# BookLoop — Proposed Schema v1 (final design for approval)

**Status:** PROPOSAL. No SQL has been executed, no database touched, no migration file written.
**Supersedes:** the schema/trigger/lock sections of `DATABASE_DESIGN_REVIEW.md` where they differ (differences are itemised in §1).
**PRD:** unmodified.
**Awaiting:** your approval of §10 before Phase 1 (migrations + seed + DB tests) begins.

> **Evidence labels.** *STATIC* = reasoned from documented PostgreSQL behaviour, not run. Every SQL block below is *unvalidated* until Phase 1 executes it against a disposable Neon branch.

---

## Phase 1 amendments (applied; **the migration files in `backend/db/migrations/` are now the schema of record**)

| # | Change | Reason |
|---|---|---|
| A-1 | **T-D extended.** The loans update trigger is now a plain `BEFORE UPDATE` and rejects any change to `id`, `request_id`, `copy_id`, `borrower_id`, `lender_id`, `borrowed_at`, `due_at` (SQLSTATE `LD011`). `returned_at` remains write-once (`LD008`). `id` was added beyond your list. | Your requested final integrity improvement. Consequence: **due dates cannot be extended in v1** (no renewals); a later migration would be needed. |
| A-2 | **T-G added** (`ctrg_request_fulfilment`, `ctrg_loan_fulfilment`): deferred constraint triggers enforcing `loan exists ⇔ request is FULFILLED` at COMMIT (`LD012` / `LD006`). T-A…T-F are unchanged. | Found while designing DB-21. The approved immediate triggers allowed a transaction to insert a loan and commit **without** flipping the request, leaving `APPROVED` request + active loan: the exact state C-1 prevents. T-G is additive and removable. |
| A-3 | **Error mapping note:** `ON DELETE RESTRICT` raises **`23001`** (`restrict_violation`), not `23503`. The API's error map (Phase 3) must handle both. | Observed in DB-29 / DB-30. |
| A-4 | Tests DB-35 … DB-45 added (§8). | Immutability and T-G coverage. |
| A-5 | `DISABLE TRIGGER` in a test transaction must come **before** any statement that queues deferred events (PostgreSQL refuses `ALTER TABLE` otherwise). | Observed in DB-21 / DB-44. Test-harness detail only. |

Unchanged and still as specified below: D-7 (service-layer only), no `handed_off_by` / `returned_recorded_by` in v1.

---

## 0. Decisions recorded

| ID | Decision (approved) |
|---|---|
| D-1 | Availability is a **derived view**. No stored availability status. |
| D-2 | Keep `loans.lender_id`, guarded by composite FK. Documented as deliberate cross-table redundancy. |
| D-3 | No waitlist: a request can be created only while the copy is available. |
| D-4 | The borrower of a returned loan may review the book once. |
| D-5 | Due date: default 14 days; owner chooses 1–60 days at handoff. |
| D-6 | Optional `contact_info`, shown only to the counterparty of an `APPROVED` request / active loan. |
| D-7 | A member with ≥1 overdue loan cannot create new requests. Exception policy in §0.1. |
| D-8 | Deactivation semantics as in review §6.6 (restated §3.6). |
| D-9 | Owner records handoff and return; admin may override. |
| D-10 | Members create catalogue entries; admin edits/merges. |
| D-11 | Lost books out of scope for v1. |
| D-12 | `ILIKE` search initially. |
| **Clarification 1** | Approved-reservation cancel / no-show workflow documented in §3; release is atomic; automatic expiry out of scope. |
| **Clarification 2** | Final consistency pass done (§1); trigger set re-derived (§5); one lock order for **all** lending writes (§2). |

### 0.1 D-7 exception policy (my proposal — please confirm)

* The block applies **only to creating new requests**. A member with an overdue loan can still return books, cancel requests, and (as owner) approve, reject and hand off.
* The block is **derived**, not stored. There is no flag to clear. It disappears the instant the overdue loan has `returned_at` set.
* Because the *owner* records returns (D-9), a borrower who has physically returned a book is blocked until the owner records it. Mitigation: the owner or an admin records the return, and the API error names the overdue loan(s) and lender so the borrower knows whom to contact.
* No grace period and no exception table in v1. Admin override = admin records the return.
* The API returns `409` with code `OVERDUE_LOANS_BLOCK`. The UI must explain the rule at the point of blocking.
* Enforced in the **service layer only**. It is a policy, not a database integrity rule, so there is no trigger (§5.2).

---

## 1. Consistency pass: what I found and changed

I re-derived every constraint, composite FK, trigger and lock from first principles. Items 1–6 are **changes**; 7–11 are **checked, no change**.

| # | Finding | Severity | Resolution |
|---|---|---|---|
| **1** | **Event timestamps written with `now()` can violate my own CHECK constraints under the lock protocol.** `now()` is *transaction start* time. Scenario: return-txn `BEGIN`s at t0, blocks on the copy lock held by a handoff-txn that started at t1 > t0, then proceeds after it commits. `returned_at = now() = t0 < borrowed_at = t1` → `ck_loans_returned` fails with a spurious 23514. The same applies to `decided_at` vs `created_at` and `cancelled_at` vs `decided_at`. The protocol I proposed in the review *creates* this waiting. | **HIGH** (STATIC) | Rule: `decided_at`, `cancelled_at`, `returned_at` are set with **`clock_timestamp()`**, never `now()`/`CURRENT_TIMESTAMP`. `created_at` / `borrowed_at` keep `DEFAULT now()` (they are the *earlier* event, so a transaction-start value is always ≤ any later `clock_timestamp()`). `now()` stays correct for the overdue comparison. Must be proven by a Phase 2 test (two clients, deliberately started in the "wrong" order). |
| **2** | **Lock order was not uniform.** Review §7 had create-request and cancel without the copy lock, and trigger T2 acquired the copy lock *after* the request row lock (a `BEFORE UPDATE` row trigger runs after the UPDATE has locked its row). | MEDIUM | **Every** lending write (create, approve, reject, cancel, handoff, return, delist/relist, deactivation sweep) takes the copy lock **first**, then request, then loan (§2). In-trigger locks are demoted to a *safety net*: on the service path they are re-entrant no-ops, never the first acquisition. They can only create a lock-order inversion for out-of-protocol direct SQL, where PostgreSQL's deadlock detector aborts one side (40P01) and nothing becomes inconsistent. |
| **3** | **Trigger set trimmed.** Review T5 (delist guard) and the "listed + owner active" checks inside T2 were *policy*, not integrity: violating them leaves no contradictory data (an unlisted copy simply is not discoverable; handoff and return still work). | MEDIUM | Moved to the service layer under the copy lock (§2). Triggers now only enforce rules that are cross-row/cross-table **and** have no declarative form (§5). |
| **4** | **No record of who cancelled.** "Owner cancelled approved request (no-show)" and "requester withdrew" were indistinguishable, which weakens Clarification 1 and the request-funnel analytics. | MEDIUM | Added `borrow_requests.cancelled_by` (FK to users) with a CHECK that it is set iff `status='CANCELLED'`. |
| **5** | **`ck_req_timestamps` did not constrain `cancelled_at ≥ decided_at`** for approved-then-cancelled requests. | LOW | Added to the time-order CHECK. |
| **6** | **Review H-9 used SQLSTATE `BL001`.** Class `B*` falls in the SQL-standard-reserved range (0–4, A–H). Implementation-defined classes begin with 5–9 or I–Z. | LOW | Custom errors use class `LD` (`LD001`…`LD010`). Phase 1 confirms PostgreSQL accepts them. |
| 7 | Composite FK column matching: `loans(request_id, copy_id, borrower_id)` → `borrow_requests(id, copy_id, requester_id)` needs a UNIQUE on exactly that column set; `loans(copy_id, lender_id)` → `copies(id, owner_id)` likewise. | — | Both targets exist (`uq_req_match`, `uq_copies_id_owner`). Types identical (UUID). No change. |
| 8 | Does `UPDATE copies SET is_listed=…` conflict with FK checks from `loans`? | — | No: it changes no key column, so it takes `FOR NO KEY UPDATE`, compatible with the FK's `FOR KEY SHARE`. The explicit service mutex `FOR UPDATE` *does* block them, which is intended (all lending writes already hold it). (STATIC) |
| 9 | Cancel-vs-handoff on a loan row: composite FK takes only `FOR KEY SHARE` on the request; a concurrent `UPDATE status` takes `FOR NO KEY UPDATE`; these are **compatible**. | — | Already handled: handoff locks the request `FOR UPDATE`; T-C's `FOR SHARE` covers direct SQL. No change. |
| 10 | Deactivation racing with approval can leave an `APPROVED` request on a just-deactivated owner's copy. | LOW | Accepted and documented (§3.6): the copy is not discoverable, an admin can cancel or hand off, and no data is contradictory. No user-row lock is added, which would introduce a user→copy vs copy→user ordering problem. |
| 11 | Deactivation racing with request creation can leave one stray `PENDING` request from a deactivated user. | LOW | Accepted: handoff re-checks that the borrower is active, so it can never become a loan. |

---

## 2. Final lock protocol

**Rule 0.** One checked-out `pg` client per transaction; `BEGIN` … `COMMIT`; `ROLLBACK` in `catch`; `release()` in `finally`. Never continue after a database error inside a transaction.
**Rule 1.** First statement after `BEGIN`: `SET LOCAL lock_timeout = '3s';`
**Rule 2 (single order).** `users` (deactivation only) → **`copies`** → **`borrow_requests`** → **`loans`**. When one transaction needs several copy locks (deactivation sweep), take them in ascending `copies.id` order.
**Rule 3.** Authorisation, status and availability are evaluated **after** the locks are held, against the locked rows.
**Rule 4.** State changes are compare-and-set: `UPDATE … WHERE id=$1 AND status='<expected>' RETURNING …`. Zero rows → `409`.
**Rule 5.** Event timestamps `decided_at`, `cancelled_at`, `returned_at` = `clock_timestamp()` (§1, item 1).

Locks use `SELECT … FOR UPDATE`. Locating the copy from a request or loan is one statement that locks only the copy (`FOR UPDATE OF c`). The `copy_id` is immutable (trigger T-B), so the lookup cannot go stale.

| Operation | Lock sequence | Checks (after locks) | Write | Failure → HTTP |
|---|---|---|---|---|
| **Create request** | copy | requester active; owner active; copy listed; requester ≠ owner; copy currently available (D-3); requester has no overdue loan (D-7) | `INSERT` request | not available / overdue → 409; own copy → 403/422 |
| **Approve** | copy → request | actor = owner; request `PENDING`; copy listed; owner active; no active loan; no `APPROVED` | CAS `PENDING→APPROVED`, `decided_at` | not owner → 403/404; state → 409 |
| **Reject** | copy → request | actor = owner; `PENDING` | CAS `PENDING→REJECTED`, `decided_at` | 403/404; 409 |
| **Cancel** | copy → request | actor ∈ {requester; owner *only if* `APPROVED`; admin} | CAS `{PENDING,APPROVED}→CANCELLED`, `cancelled_at`, `cancelled_by` | 403/404; 409 |
| **Handoff** | copy → request | actor ∈ {owner, admin}; request `APPROVED`; borrower active; `1 ≤ days ≤ 60` | `INSERT` loan; then CAS `APPROVED→FULFILLED` | 403/404; 409 |
| **Return** | copy → loan | actor ∈ {owner, admin} | CAS `returned_at` where `returned_at IS NULL`, `clock_timestamp()` | 403/404; 409 (already returned) |
| **Delist** | copy | no `APPROVED` request; no active loan | `is_listed=false` | 409 |
| **Relist / edit** | copy | actor = owner | update | 403/404 |
| **Deactivate user** | user → *(per affected request, ascending copy id)* copy → request | actor = admin | `deactivated_at`; CAS cancel requester's `PENDING`/`APPROVED` requests (`cancelled_by` = admin) | 403 |
| **Create review** | *(not a lending transition; no copy lock)* | actor = loan's borrower; loan returned | `INSERT` review | 403/404; 409 duplicate; 409/422 not returned |

> `Create review` is the only write that does not take the copy lock: it touches neither availability nor reservations. `returned_at` is write-once (T-D), so there is nothing to race against.

**Handoff SQL order matters** (T-C then T-B): insert the loan while the request is still `APPROVED`, then flip the request to `FULFILLED` (T-B verifies the loan exists).

**Due date (STATIC, unvalidated):** end of day IST of *today + N* days:

```sql
((((now() AT TIME ZONE 'Asia/Kolkata')::date + ($1::int + 1))::timestamp) AT TIME ZONE 'Asia/Kolkata')
```

i.e. midnight starting day *today + N + 1*. `due_at < now()` then means "past the end of the due day".

---

## 3. Approved-reservation cancellation and no-show workflow (Clarification 1)

### 3.1 State machine with actors

```
 PENDING ──approve (owner)──────────▶ APPROVED ──handoff (owner|admin)──▶ FULFILLED  (terminal, loan exists)
    │                                    │  │
    ├──reject (owner)──▶ REJECTED        │  └──cancel (requester | owner | admin)──▶ CANCELLED
    │                    (terminal)      │                                           (terminal)
    └──cancel (requester | admin)────────┘ (PENDING→CANCELLED also by requester)
```

| From → To | Requester | Owner | Admin |
|---|---|---|---|
| `PENDING → APPROVED` | – | ✔ | – |
| `PENDING → REJECTED` | – | ✔ | – |
| `PENDING → CANCELLED` | ✔ (withdraw) | – (uses reject) | ✔ |
| `APPROVED → CANCELLED` | ✔ (withdraw) | ✔ (**no-show / changed mind**) | ✔ |
| `APPROVED → FULFILLED` | – | ✔ (handoff) | ✔ (override) |
| Everything else (incl. all moves out of `REJECTED`, `CANCELLED`, `FULFILLED`) | illegal (trigger T-B, 23xxx `LD004`) | | |

### 3.2 Why the release is atomic

The reservation **is** the row's status. There is no separate reservation record and no stored availability flag:

* The cancel is a single `UPDATE … SET status='CANCELLED', cancelled_at=clock_timestamp(), cancelled_by=$actor WHERE id=$1 AND status IN ('PENDING','APPROVED')`.
* That one statement simultaneously (a) removes the row from `uq_req_one_approved_per_copy`, (b) makes the `NOT EXISTS (… status='APPROVED')` branch of `available_copies` true, and (c) frees the `(copy_id, requester_id)` open-request slot.
* All three become visible at commit, together. A reader sees the reservation or its absence, never a half-released copy.
* The copy lock (Rule 2) means the cancel also serialises against a concurrent handoff of the same request, a concurrent approval of a sibling, and a concurrent delist.

### 3.3 Concurrency outcomes

| Race | Outcome |
|---|---|
| Requester cancel vs owner cancel | First wins; second CAS affects 0 rows → `409`. |
| Cancel vs handoff | Serialised by the copy lock. Cancel first → handoff sees `CANCELLED` → `409`. Handoff first → cancel sees `FULFILLED` → `409`; no loan for a cancelled request is possible. |
| Cancel vs approval of sibling `PENDING` | Sibling approval waits; after commit it sees no `APPROVED` and succeeds. |
| Cancel vs delist | Delist waits, then proceeds (no `APPROVED` left). |

### 3.4 After a no-show cancellation

* The copy is immediately discoverable again (if listed, owner active, no loan).
* Sibling `PENDING` requests stay `PENDING`; the owner may now approve one.
* The cancelled requester may re-request (the open-request index excludes `CANCELLED`). No penalty in v1.
* The owner's incoming-requests list shows approval age (`now() - decided_at`) so stale reservations are visible. **There is no automatic expiry in v1** (out of scope per your instruction); the owner cancels manually.

### 3.5 Analytics that this enables

`cancelled_by = requester_id` → "withdrawn"; `cancelled_by = owner` and `decided_at IS NOT NULL` → "owner-cancelled after approval"; both are derived, with no extra status value.

### 3.6 Deactivation (D-8) restated, with its documented races

On admin deactivation (one transaction): set `deactivated_at`; cancel the user's own `PENDING`/`APPROVED` requests as requester (`cancelled_by` = admin). Listings become undiscoverable through the view. Incoming requests are left as-is. Active loans (either role) are untouched; the admin can record the return. Reviews and history are untouched.
Accepted benign races: §1 items 10–11.

---

## 4. Final schema (DDL, unexecuted)

```sql
-- ===== 0001_extensions.sql =====
CREATE EXTENSION IF NOT EXISTS citext;
-- optional (P1 search index): CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ===== 0002_users_catalog.sql =====
CREATE TABLE users (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                   CITEXT      NOT NULL,
  password_hash           TEXT        NOT NULL,
  display_name            TEXT        NOT NULL,
  role                    TEXT        NOT NULL DEFAULT 'MEMBER',
  default_pickup_location TEXT,
  contact_info            TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_at          TIMESTAMPTZ,
  CONSTRAINT uq_users_email        UNIQUE (email),
  CONSTRAINT ck_users_role         CHECK (role IN ('MEMBER','ADMIN')),
  CONSTRAINT ck_users_email_format CHECK (email::text ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  CONSTRAINT ck_users_name_len     CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 80),
  CONSTRAINT ck_users_deactivated  CHECK (deactivated_at IS NULL OR deactivated_at >= created_at)
);

CREATE TABLE books (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT        NOT NULL,
  isbn             TEXT,                     -- ISBN-13, digits only, app-normalised
  edition          TEXT,
  publisher        TEXT,
  publication_year SMALLINT,
  description      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_books_isbn  UNIQUE (isbn),   -- NULLs are distinct in PostgreSQL
  CONSTRAINT ck_books_title CHECK (char_length(btrim(title)) > 0),
  CONSTRAINT ck_books_isbn  CHECK (isbn IS NULL OR isbn ~ '^97[89][0-9]{10}$'),
  CONSTRAINT ck_books_year  CHECK (publication_year IS NULL OR publication_year BETWEEN 1400 AND 2100)
);

CREATE TABLE authors (
  id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  CONSTRAINT ck_authors_name CHECK (char_length(btrim(name)) > 0)
);
CREATE UNIQUE INDEX uq_authors_name ON authors (lower(name));

CREATE TABLE genres (
  id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  CONSTRAINT ck_genres_name CHECK (char_length(btrim(name)) > 0)
);
CREATE UNIQUE INDEX uq_genres_name ON genres (lower(name));

CREATE TABLE book_authors (
  book_id      UUID     NOT NULL REFERENCES books(id)   ON DELETE CASCADE,
  author_id    UUID     NOT NULL REFERENCES authors(id) ON DELETE RESTRICT,
  author_order SMALLINT NOT NULL DEFAULT 1,
  PRIMARY KEY (book_id, author_id),
  CONSTRAINT uq_book_authors_order UNIQUE (book_id, author_order),
  CONSTRAINT ck_book_authors_order CHECK (author_order >= 1)
);

CREATE TABLE book_genres (
  book_id  UUID NOT NULL REFERENCES books(id)  ON DELETE CASCADE,
  genre_id UUID NOT NULL REFERENCES genres(id) ON DELETE RESTRICT,
  PRIMARY KEY (book_id, genre_id)
);

-- ===== 0003_copies.sql =====
CREATE TABLE copies (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id         UUID        NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
  owner_id        UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  copy_condition  TEXT        NOT NULL DEFAULT 'GOOD',
  is_listed       BOOLEAN     NOT NULL DEFAULT TRUE,      -- owner intent, NOT availability
  pickup_location TEXT,                                   -- override; falls back to owner's default
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_copies_condition CHECK (copy_condition IN ('NEW','LIKE_NEW','GOOD','FAIR','POOR')),
  CONSTRAINT uq_copies_id_owner  UNIQUE (id, owner_id)    -- FK target for loans (lender match)
);

-- ===== 0004_borrow_requests.sql =====
CREATE TABLE borrow_requests (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  copy_id      UUID        NOT NULL REFERENCES copies(id) ON DELETE RESTRICT,
  requester_id UUID        NOT NULL REFERENCES users(id)  ON DELETE RESTRICT,
  status       TEXT        NOT NULL DEFAULT 'PENDING',
  message      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ,            -- set (clock_timestamp()) on APPROVED / REJECTED; kept after FULFILLED / CANCELLED-from-APPROVED
  cancelled_at TIMESTAMPTZ,            -- set (clock_timestamp()) on CANCELLED
  cancelled_by UUID        REFERENCES users(id) ON DELETE RESTRICT,  -- requester, owner or admin
  CONSTRAINT ck_req_status  CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED','FULFILLED')),
  CONSTRAINT ck_req_columns CHECK (
       (status = 'PENDING'                            AND decided_at IS NULL     AND cancelled_at IS NULL     AND cancelled_by IS NULL)
    OR (status IN ('APPROVED','REJECTED','FULFILLED') AND decided_at IS NOT NULL AND cancelled_at IS NULL     AND cancelled_by IS NULL)
    OR (status = 'CANCELLED'                                                     AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)),
  CONSTRAINT ck_req_time_order CHECK (
        (decided_at   IS NULL OR decided_at   >= created_at)
    AND (cancelled_at IS NULL OR cancelled_at >= created_at)
    AND (decided_at IS NULL OR cancelled_at IS NULL OR cancelled_at >= decided_at)),
  CONSTRAINT ck_req_message CHECK (message IS NULL OR char_length(message) <= 500),
  CONSTRAINT uq_req_match   UNIQUE (id, copy_id, requester_id)   -- FK target for loans (copy + borrower match)
);
CREATE UNIQUE INDEX uq_req_one_approved_per_copy
  ON borrow_requests (copy_id) WHERE status = 'APPROVED';
CREATE UNIQUE INDEX uq_req_one_open_per_member_copy
  ON borrow_requests (copy_id, requester_id) WHERE status IN ('PENDING','APPROVED');

-- ===== 0005_loans.sql =====
CREATE TABLE loans (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  UUID        NOT NULL,
  copy_id     UUID        NOT NULL,   -- deliberate copy of request.copy_id: partial unique index needs it on this table
  borrower_id UUID        NOT NULL,   -- deliberate copy of request.requester_id
  lender_id   UUID        NOT NULL,   -- deliberate copy of copies.owner_id at handoff (D-2)
  borrowed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at      TIMESTAMPTZ NOT NULL,
  returned_at TIMESTAMPTZ,            -- set (clock_timestamp()) once; write-once (T-D)
  CONSTRAINT uq_loans_request UNIQUE (request_id),
  CONSTRAINT fk_loans_request_match
    FOREIGN KEY (request_id, copy_id, borrower_id)
    REFERENCES borrow_requests (id, copy_id, requester_id),
  CONSTRAINT fk_loans_copy_owner
    FOREIGN KEY (copy_id, lender_id)
    REFERENCES copies (id, owner_id),
  CONSTRAINT ck_loans_not_self CHECK (borrower_id <> lender_id),
  CONSTRAINT ck_loans_due      CHECK (due_at > borrowed_at),
  CONSTRAINT ck_loans_returned CHECK (returned_at IS NULL OR returned_at >= borrowed_at)
);
CREATE UNIQUE INDEX uq_loans_one_active_per_copy
  ON loans (copy_id) WHERE returned_at IS NULL;

-- ===== 0006_reviews.sql =====
CREATE TABLE reviews (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id    UUID        NOT NULL REFERENCES loans(id) ON DELETE RESTRICT,
  rating     SMALLINT    NOT NULL,
  comment    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),   -- reviewer = loans.borrower_id by construction
  CONSTRAINT uq_reviews_loan    UNIQUE (loan_id),
  CONSTRAINT ck_reviews_rating  CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT ck_reviews_comment CHECK (comment IS NULL OR char_length(comment) <= 2000)
);
```

Notes:

* `borrower_id` / `lender_id` reference `users` transitively through the composite FKs; explicit FKs to `users` are unnecessary.
* The three `UNIQUE (id, …)` constraints are redundant for lookups and exist only as composite-FK targets.
* **Not in the database, by decision:** due-window 1–60 days (policy, service), overdue block (policy, service), "≥ 1 author per book" (service).

---

## 5. Final trigger set (re-derived)

### 5.1 The test applied to each trigger

> Keep a trigger only if the rule is (a) a data-integrity invariant, (b) cross-row or cross-table or old-vs-new, and (c) has **no** declarative form without extra denormalisation.

| ID | Table / event | Integrity rule | Why it cannot be declarative | If removed |
|---|---|---|---|---|
| **T-A** | `borrow_requests` BEFORE INSERT | Requests start `PENDING`; requester ≠ copy owner | `CHECK` cannot see another table or distinguish insert from update. The declarative alternative (copy owner onto the request + composite FK) adds a 3NF-violating column. | Self-requests and pre-approved inserts possible via direct SQL. |
| **T-B** | `borrow_requests` BEFORE UPDATE OF status, copy_id, requester_id, created_at | Legal transitions only; identity columns immutable; `→APPROVED` requires no active loan on the copy; `→FULFILLED` requires a loan row | Old-vs-new comparison and the cross-table exclusion "approved XOR on loan" have no index or constraint form. | `REJECTED→APPROVED`, double reservation against an active loan, FULFILLED with no loan. |
| **T-C** | `loans` BEFORE INSERT | Loan's request is `APPROVED` | `FK` cannot test a status value (only the `copy`/`borrower` match, done by composite FK). | A loan for a `REJECTED`/`CANCELLED`/`PENDING` request. |
| **T-D** | `loans` BEFORE UPDATE | Loan identity and terms (`id`, `request_id`, `copy_id`, `borrower_id`, `lender_id`, `borrowed_at`, `due_at`) are immutable; `returned_at` is write-once *(amended, A-1)* | Old-vs-new comparison. | A returned loan could be re-opened or its terms rewritten, orphaning a review and silently changing history. |
| **T-G** | `borrow_requests` AFTER INSERT/UPDATE OF status, `loans` AFTER INSERT, both **deferred** *(added, A-2)* | At commit: a loan exists ⇔ its request is `FULFILLED` | A cross-table "exactly when" invariant that must hold only at transaction end (the handoff legitimately needs two statements). | A commit could leave an `APPROVED` request next to an active loan. |
| **T-E** | `copies` BEFORE UPDATE OF owner_id | `owner_id` immutable | Old-vs-new comparison. Makes "no transfers" (D-2, H-7) a database fact and keeps T-A sound. | Ownership could change before the first loan, silently rewriting history. |
| **T-F** | `reviews` BEFORE INSERT | The loan is returned | `FK` cannot test a nullable column's nullness in the parent. | Review of an unreturned loan. |

**Removed relative to the review:** the delist guard and the "listed / owner active" checks (§1, item 3). They are service rules under the copy lock.
**Candidates to cut if you want fewer still:** T-D and T-E (history protection). Consequence of cutting either is listed in the "if removed" column; neither affects the lending exclusivity rules.

### 5.2 Rules deliberately **not** triggers

Overdue block (D-7); due-date window (D-5); copy listed / owner active / requester active at create and approve; delist guard; deactivated user cannot list or request; actor authorisation (owner / admin / requester); "≥ 1 author"; maximum review count.

### 5.3 Trigger bodies (unexecuted)

```sql
-- ===== 0007_guard_triggers.sql =====

-- T-A
CREATE FUNCTION fn_requests_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_owner UUID;
BEGIN
  IF NEW.status <> 'PENDING' THEN
    RAISE EXCEPTION 'a request must start as PENDING' USING ERRCODE = 'LD001';
  END IF;
  SELECT owner_id INTO v_owner FROM copies WHERE id = NEW.copy_id;
  IF FOUND AND v_owner = NEW.requester_id THEN      -- missing copy: the FK reports it (23503)
    RAISE EXCEPTION 'a member cannot request their own copy' USING ERRCODE = 'LD002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_requests_before_insert BEFORE INSERT ON borrow_requests
  FOR EACH ROW EXECUTE FUNCTION fn_requests_before_insert();

-- T-B
CREATE FUNCTION fn_requests_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.copy_id <> OLD.copy_id OR NEW.requester_id <> OLD.requester_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'request identity columns are immutable' USING ERRCODE = 'LD003';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ( (OLD.status = 'PENDING'  AND NEW.status IN ('APPROVED','REJECTED','CANCELLED'))
          OR (OLD.status = 'APPROVED' AND NEW.status IN ('FULFILLED','CANCELLED')) ) THEN
      RAISE EXCEPTION 'illegal request transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'LD004';
    END IF;

    IF NEW.status = 'APPROVED' THEN
      PERFORM id FROM copies WHERE id = NEW.copy_id FOR UPDATE;   -- safety net; no-op on the service path
      IF EXISTS (SELECT 1 FROM loans WHERE copy_id = NEW.copy_id AND returned_at IS NULL) THEN
        RAISE EXCEPTION 'copy is currently on loan' USING ERRCODE = 'LD005';
      END IF;
    ELSIF NEW.status = 'FULFILLED' THEN
      IF NOT EXISTS (SELECT 1 FROM loans WHERE request_id = NEW.id) THEN
        RAISE EXCEPTION 'cannot fulfil a request that has no loan' USING ERRCODE = 'LD006';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_requests_before_update
  BEFORE UPDATE OF status, copy_id, requester_id, created_at ON borrow_requests
  FOR EACH ROW EXECUTE FUNCTION fn_requests_before_update();

-- T-C
CREATE FUNCTION fn_loans_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM borrow_requests WHERE id = NEW.request_id FOR SHARE;
  IF FOUND AND v_status <> 'APPROVED' THEN          -- missing request: the FK reports it (23503)
    RAISE EXCEPTION 'a loan requires an APPROVED request (found %)', v_status
      USING ERRCODE = 'LD007';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_loans_before_insert BEFORE INSERT ON loans
  FOR EACH ROW EXECUTE FUNCTION fn_loans_before_insert();

-- T-D  (AMENDED, A-1: see backend/db/migrations/0007_guard_triggers.sql for the executed version)
--   BEFORE UPDATE (all columns): raise LD011 if id, request_id, copy_id, borrower_id, lender_id,
--   borrowed_at or due_at IS DISTINCT FROM its old value; raise LD008 if returned_at was already
--   set and changes. T-G (deferred constraint triggers) is also in 0007.

-- T-E
CREATE FUNCTION fn_copies_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id <> OLD.owner_id THEN
    RAISE EXCEPTION 'copy ownership cannot be changed' USING ERRCODE = 'LD009';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_copies_before_update BEFORE UPDATE OF owner_id ON copies
  FOR EACH ROW EXECUTE FUNCTION fn_copies_before_update();

-- T-F
CREATE FUNCTION fn_reviews_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_returned TIMESTAMPTZ;
BEGIN
  SELECT returned_at INTO v_returned FROM loans WHERE id = NEW.loan_id;
  IF FOUND AND v_returned IS NULL THEN              -- missing loan: the FK reports it (23503)
    RAISE EXCEPTION 'only returned loans can be reviewed' USING ERRCODE = 'LD010';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_reviews_before_insert BEFORE INSERT ON reviews
  FOR EACH ROW EXECUTE FUNCTION fn_reviews_before_insert();
```

**Points to verify in Phase 1 (STATIC until run):** `PERFORM … FOR UPDATE` is accepted in PL/pgSQL; `BEFORE UPDATE OF` column lists fire as intended; custom `LD…` SQLSTATEs are accepted; a `CHECK` violation is reported before the FK's trigger (DB-20 below).

---

## 6. Performance indexes and views

```sql
-- ===== 0008_performance_indexes.sql =====
CREATE INDEX ix_book_authors_author ON book_authors (author_id);
CREATE INDEX ix_book_genres_genre   ON book_genres  (genre_id);
CREATE INDEX ix_copies_book         ON copies       (book_id);
CREATE INDEX ix_copies_owner        ON copies       (owner_id);
CREATE INDEX ix_req_requester       ON borrow_requests (requester_id, created_at DESC);
CREATE INDEX ix_req_copy            ON borrow_requests (copy_id);
CREATE INDEX ix_loans_borrower      ON loans (borrower_id, borrowed_at DESC);
CREATE INDEX ix_loans_lender        ON loans (lender_id,   borrowed_at DESC);
CREATE INDEX ix_loans_open_due      ON loans (due_at) WHERE returned_at IS NULL;
-- optional, P1 search demo: CREATE INDEX ix_books_title_trgm ON books USING gin (title gin_trgm_ops);
```

| Index | Query it serves |
|---|---|
| `ix_book_authors_author`, `ix_book_genres_genre` | books by author / genre; popular-genres join |
| `ix_copies_book` | copies of a title (book detail, search) |
| `ix_copies_owner` | "My listings" |
| `ix_req_requester` | "My requests" (newest first) |
| `ix_req_copy` | per-copy history; incoming-requests join; analytics (the two partial unique indexes only cover `PENDING`/`APPROVED`) |
| `ix_loans_borrower` / `ix_loans_lender` | borrower / lender history |
| `ix_loans_open_due` | active and overdue lists, ordered by due date. The predicate is `returned_at IS NULL`; `due_at < now()` is not allowed in a partial index (`now()` is not immutable). |

Indexes created by constraints (no separate statement): `users(email)`, `books(isbn)`, `uq_authors_name`, `uq_genres_name`, both `uq_req_*` partial indexes, `loans(request_id)`, `uq_loans_one_active_per_copy`, `reviews(loan_id)`, all PKs.

```sql
-- ===== 0009_views.sql =====
CREATE VIEW available_copies AS
SELECT c.id AS copy_id, c.book_id, c.owner_id, c.copy_condition,
       COALESCE(c.pickup_location, u.default_pickup_location) AS pickup_location
FROM copies c
JOIN users u ON u.id = c.owner_id AND u.deactivated_at IS NULL
WHERE c.is_listed
  AND NOT EXISTS (SELECT 1 FROM loans l
                  WHERE l.copy_id = c.id AND l.returned_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM borrow_requests r
                  WHERE r.copy_id = c.id AND r.status = 'APPROVED');

CREATE VIEW active_loans AS
SELECT l.*, (l.due_at < now()) AS is_overdue
FROM loans l WHERE l.returned_at IS NULL;

CREATE VIEW overdue_loans AS
SELECT l.* FROM loans l WHERE l.returned_at IS NULL AND l.due_at < now();
```

Analytics views (`most_borrowed_titles`, `popular_genres`, `member_activity`, `return_timeliness`, `request_funnel`) are written in Phase 1 against the metric definitions in review §5.5. They contain no schema decisions needing approval now.

`available_copies` is an **advisory snapshot**. The authoritative check is repeated under the copy lock (§2).

---

## 7. Rule → mechanism matrix

| Rule | Mechanism | Layer | Phase-1 DB test? |
|---|---|---|---|
| Case-insensitive unique email | `citext` + `UNIQUE` | Declarative | ✔ DB-01 |
| Optional unique ISBN, ISBN-13 shape | `UNIQUE` (NULLs distinct) + `CHECK` | Declarative | ✔ DB-03/04 |
| Domains: role, condition, status, rating | `CHECK` | Declarative | ✔ DB-06/07 |
| Status ↔ timestamp ↔ `cancelled_by` coherence | `CHECK` | Declarative | ✔ DB-34 |
| Self-borrow (loan) | `CHECK` | Declarative | ✔ DB-20 |
| Self-request | T-A | Trigger | ✔ DB-08 |
| ≤ 1 `APPROVED` per copy | partial unique index | Declarative | ✔ DB-11 |
| ≤ 1 open request per member per copy | partial unique index | Declarative | ✔ DB-10 |
| ≤ 1 active loan per copy | partial unique index | Declarative | ✔ DB-21 |
| One loan per request | `UNIQUE(request_id)` | Declarative | ✔ DB-22 |
| Loan copy / borrower = request's | composite FK | Declarative | ✔ DB-17/18 |
| Lender = copy owner at handoff | composite FK | Declarative | ✔ DB-19 |
| Valid transitions; identity immutable | T-B (+ CAS in service) | Trigger + service | ✔ DB-12/13 |
| Approved XOR on-loan | copy lock (service) + T-B | Transaction + trigger | ✔ DB-14 (SQL); race = Phase 2 |
| Loan requires `APPROVED` request | T-C | Trigger | ✔ DB-16 |
| `FULFILLED` ⇒ loan exists | T-B | Trigger | ✔ DB-15 |
| Returned loan write-once | T-D (+ CAS in service) | Trigger + service | ✔ DB-25 |
| No ownership change | T-E (+ composite FK once loans exist) | Trigger + FK | ✔ DB-26 |
| Review only for returned loan; one per loan | T-F + `UNIQUE(loan_id)` | Trigger + declarative | ✔ DB-27/28 |
| History retained | `ON DELETE RESTRICT`; no delete endpoints; `deactivated_at` | Declarative | ✔ DB-29/30 |
| Reviewer = borrower | service (reviewer derived, not stored) | Service | Phase 2 |
| Overdue block, due window, active-user checks, delist guard, authorisation | service under copy lock | Service | Phase 2 |
| Atomic multi-step operations | single client transaction | Transaction | Phase 2 |
| Races (approve/approve, approve/delist, return/approve, cancel/handoff, double return) | copy lock + CAS + indexes | Transaction | Phase 2 |

---

## 8. Migration plan

Forward-only, numbered, one concern per file. A small runner applies each file in one transaction and records `version` + `checksum` in `schema_migrations`; it refuses a changed checksum or an out-of-order file.

| # | File | Objects | Inspect afterwards |
|---|---|---|---|
| 0001 | `0001_extensions.sql` | `citext` (`pg_trgm` optional) | `SELECT extname FROM pg_extension;` |
| 0002 | `0002_users_catalog.sql` | `users`, `books`, `authors`, `genres`, `book_authors`, `book_genres` | constraints, unique indexes |
| 0003 | `0003_copies.sql` | `copies` | `uq_copies_id_owner` present |
| 0004 | `0004_borrow_requests.sql` | `borrow_requests` + 2 partial unique indexes | partial predicates in `pg_indexes` |
| 0005 | `0005_loans.sql` | `loans` + composite FKs + partial unique index | `pg_get_constraintdef` of both FKs |
| 0006 | `0006_reviews.sql` | `reviews` | |
| 0007 | `0007_guard_triggers.sql` | 6 functions + 6 triggers | `pg_trigger` |
| 0008 | `0008_performance_indexes.sql` | indexes in §6 | `pg_indexes` |
| 0009 | `0009_views.sql` | 3 core views (+ analytics views in Phase 1) | `pg_views` |

Inspection queries (to be run in Phase 1, not now):

```sql
SELECT conrelid::regclass AS tbl, conname, contype, pg_get_constraintdef(oid)
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2;
SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2;
SELECT tgrelid::regclass AS tbl, tgname, pg_get_triggerdef(oid)
  FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2;
```

**Seeds** (`backend/db/seed/`):

* `001_reference.sql`: genres; idempotent (`ON CONFLICT DO NOTHING`).
* `002_demo.*`: ≈12 users, ≈25 books, authors/genres, ≈35 copies. Replays the **real lifecycle** with explicit historical timestamps: pending, approved, rejected, withdrawn-cancelled, **owner-cancelled-after-approval**, active, returned, overdue loans, a few reviews. Seed accounts use a documented dev-only password hashed at run time. Refuses to run unless `ALLOW_SEED=true`, and never against a host not on an allow-list.

**Environment:** migrations on the Neon **direct** connection; the app on the **pooled** one; integration tests on a separate Neon **test branch**. Connection strings stay in `.env`, never committed, never shared with me.

**Reset (disposable branch only):** `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` then re-run migrations.

### Phase 1 database tests (pure SQL via `pg`, each in a rolled-back transaction)

| ID | Setup → action | Expected |
|---|---|---|
| DB-01 | two emails differing by case | 23505 `uq_users_email` |
| DB-02 | email without `@` / with spaces | 23514 `ck_users_email_format` |
| DB-03 | duplicate ISBN; two NULL ISBNs | 23505; second pair OK |
| DB-04 | ISBN `123` | 23514 `ck_books_isbn` |
| DB-05 | copy with unknown `book_id` | 23503 |
| DB-06 | bad role / condition / status | 23514 |
| DB-07 | rating 0 and 6 | 23514 `ck_reviews_rating` |
| DB-08 | requester = owner | `LD002` |
| DB-09 | insert request with `status='APPROVED'` | `LD001` |
| DB-10 | same member, same copy, two open requests | 23505 `uq_req_one_open_per_member_copy` |
| DB-11 | two requesters both `APPROVED` for one copy | 23505 `uq_req_one_approved_per_copy` |
| DB-12 | `REJECTED→APPROVED`, `CANCELLED→PENDING`, `FULFILLED→CANCELLED`, `PENDING→FULFILLED` | `LD004` each |
| DB-13 | change `copy_id` / `requester_id` | `LD003` |
| DB-14 | `PENDING→APPROVED` while an active loan exists | `LD005` |
| DB-15 | `APPROVED→FULFILLED` with no loan | `LD006` |
| DB-16 | loan for `PENDING` / `REJECTED` / `CANCELLED` request | `LD007` |
| DB-17 | loan with a different `copy_id` than the request | 23503 `fk_loans_request_match` |
| DB-18 | loan with a different `borrower_id` | 23503 `fk_loans_request_match` |
| DB-19 | loan with `lender_id` ≠ copy owner | 23503 `fk_loans_copy_owner` |
| DB-20 | `borrower_id = lender_id` | 23514 `ck_loans_not_self` (also confirms CHECK fires before FK) |
| DB-21 | second active loan, same copy | 23505 `uq_loans_one_active_per_copy` |
| DB-22 | second loan, same request | 23505 `uq_loans_request` |
| DB-23 | `due_at <= borrowed_at` | 23514 `ck_loans_due` |
| DB-24 | `returned_at < borrowed_at` | 23514 `ck_loans_returned` |
| DB-25 | change `returned_at` after it is set | `LD008` |
| DB-26 | change `owner_id` (copy without and with loans) | `LD009` both |
| DB-27 | review of an unreturned loan | `LD010` |
| DB-28 | second review of one loan | 23505 `uq_reviews_loan` |
| DB-29 | deactivate user; counts of requests/loans/reviews unchanged; hard delete of user with history | counts equal; 23503 |
| DB-30 | hard delete of a copy that has requests | 23503 |
| DB-31 | `overdue_loans` with one overdue-active and one overdue-returned | only the active one |
| DB-32 | `available_copies` excludes: unlisted, deactivated owner, active loan, `APPROVED` reservation; includes a copy with only `PENDING` | as stated |
| DB-33 | cancel an `APPROVED` request | copy reappears in `available_copies` in the same transaction |
| DB-34 | `CANCELLED` without `cancelled_by`; `PENDING` with `decided_at`; `cancelled_at < decided_at` | 23514 `ck_req_columns` / `ck_req_time_order` |

Added in Phase 1 (A-1, A-2). DB-29 / DB-30 expect `23001`, see A-3:

| ID | Setup → action | Expected |
|---|---|---|
| DB-35 … DB-41 | for an **active** and a **returned** loan: change `request_id`, `copy_id`, `borrower_id`, `lender_id`, `borrowed_at`, `due_at`, `id` (values chosen so that, without T-D, the update would be accepted or fail only on an FK/CHECK) | `LD011`; row unchanged |
| DB-42 | `returned_at` NULL → value; no-op rewrite; change; set back to NULL | allowed; allowed; `LD008`; `LD008` |
| DB-43 | loan inserted, request left `APPROVED`; `SET CONSTRAINTS … IMMEDIATE` | `LD012` |
| DB-44 | request `FULFILLED` with no loan (T-B bypassed); `SET CONSTRAINTS … IMMEDIATE` | `LD006` |
| DB-45 | complete handoff; `SET CONSTRAINTS … IMMEDIATE` | passes |

Phase 2 (service + two-client concurrency) is specified separately once Phase 1 passes. It will include the §1 item 1 timestamp scenario, the Clarification 1 workflow, and the D-7 block.

---

## 9. Residual risks and what is not verified

* **Nothing here has been executed.** Syntax, trigger behaviour, lock semantics, error codes and the extension availability on Neon are all unverified until Phase 1/2 run.
* Phase 2 must prove §1 item 1 (the `now()` vs `clock_timestamp()` timestamp failure), since it is the finding I am least able to confirm by reading alone.
* Accepted: a deactivation racing with approval or request creation (§1 items 10–11).
* Accepted: no automatic reservation expiry, no lost-book closure, no grace period for the overdue block.
* Accepted: the borrower is blocked by D-7 until the owner records the return (§0.1).
* Not included: who recorded a handoff/return (admin override is not attributable). If wanted: nullable `handed_off_by` / `returned_recorded_by` on `loans`. **Your call; default is not to add them.**

---

## 10. Approval checklist

Reply "approved" to start Phase 1, or list what to change.

- [ ] **§0.1** D-7 exception policy as written (block only on new requests; derived; owner/admin records return).
- [ ] **§1 item 1** `clock_timestamp()` rule for `decided_at` / `cancelled_at` / `returned_at`.
- [ ] **§2** lock order and the operation table, including *create request* taking the copy lock.
- [ ] **§3** cancellation / no-show workflow and the actors table; `cancelled_by` column.
- [ ] **§5** trigger set T-A … T-F, with delist guard and listed/active checks moved to the service layer. (Optionally cut T-D / T-E.)
- [ ] **§4** DDL as the schema of record.
- [ ] **§8** nine migration files in that order; seed and test-branch approach; the DB-01…DB-34 test list.
- [ ] **§9** attribution columns for admin overrides: add or leave out.

*End. No SQL has been executed; no implementation has begun.*
