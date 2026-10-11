-- 0005_loans.sql
CREATE TABLE loans (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  UUID        NOT NULL,
  copy_id     UUID        NOT NULL,   -- deliberate copy of request.copy_id (a partial unique index needs it on this table)
  borrower_id UUID        NOT NULL,   -- deliberate copy of request.requester_id
  lender_id   UUID        NOT NULL,   -- deliberate copy of copies.owner_id at handoff (D-2)
  borrowed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at      TIMESTAMPTZ NOT NULL,
  returned_at TIMESTAMPTZ,            -- written once, with clock_timestamp(); write-once enforced by trigger
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

-- Only one active loan per physical copy.
CREATE UNIQUE INDEX uq_loans_one_active_per_copy
  ON loans (copy_id) WHERE returned_at IS NULL;
