-- 0004_borrow_requests.sql
CREATE TABLE borrow_requests (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  copy_id      UUID        NOT NULL REFERENCES copies(id) ON DELETE RESTRICT,
  requester_id UUID        NOT NULL REFERENCES users(id)  ON DELETE RESTRICT,
  status       TEXT        NOT NULL DEFAULT 'PENDING',
  message      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- decided_at / cancelled_at are written with clock_timestamp(), never now() (see PROPOSED_SCHEMA_V1 section 1, item 1)
  decided_at   TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
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
  -- FK target that makes loans.copy_id / loans.borrower_id match the request (C-3).
  CONSTRAINT uq_req_match   UNIQUE (id, copy_id, requester_id)
);

-- At most one outstanding reservation per physical copy.
CREATE UNIQUE INDEX uq_req_one_approved_per_copy
  ON borrow_requests (copy_id) WHERE status = 'APPROVED';
-- A member may hold at most one open request per copy.
CREATE UNIQUE INDEX uq_req_one_open_per_member_copy
  ON borrow_requests (copy_id, requester_id) WHERE status IN ('PENDING','APPROVED');
