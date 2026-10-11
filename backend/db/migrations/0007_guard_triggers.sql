-- 0007_guard_triggers.sql
-- Each trigger enforces a concrete integrity rule that has no declarative form.
-- Custom SQLSTATE class 'LD' (implementation-defined range). Codes:
--   LD001 request must start PENDING        LD007 loan requires an APPROVED request
--   LD002 requester is the copy owner       LD008 returned_at is write-once
--   LD003 request identity immutable        LD009 copy ownership immutable
--   LD004 illegal request transition        LD010 review needs a returned loan
--   LD005 copy is currently on loan         LD011 loan identity/terms immutable
--   LD006 FULFILLED without a loan          LD012 loan exists but request not FULFILLED

-- T-A: requests start PENDING; requester is not the copy owner.
CREATE FUNCTION fn_requests_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_owner UUID;
BEGIN
  IF NEW.status <> 'PENDING' THEN
    RAISE EXCEPTION 'a request must start as PENDING' USING ERRCODE = 'LD001';
  END IF;
  SELECT owner_id INTO v_owner FROM copies WHERE id = NEW.copy_id;
  IF FOUND AND v_owner = NEW.requester_id THEN   -- missing copy: the FK reports it (23503)
    RAISE EXCEPTION 'a member cannot request their own copy' USING ERRCODE = 'LD002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_requests_before_insert BEFORE INSERT ON borrow_requests
  FOR EACH ROW EXECUTE FUNCTION fn_requests_before_insert();

-- T-B: legal transitions; identity columns immutable; APPROVED needs no active loan; FULFILLED needs a loan.
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
      -- Safety net only: on the service path the copy row is already locked by this transaction.
      PERFORM id FROM copies WHERE id = NEW.copy_id FOR UPDATE;
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

-- T-C: a loan may only be created for an APPROVED request. FOR SHARE conflicts with a concurrent
-- status UPDATE (the composite FK alone takes only FOR KEY SHARE, which does not).
CREATE FUNCTION fn_loans_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM borrow_requests WHERE id = NEW.request_id FOR SHARE;
  IF FOUND AND v_status <> 'APPROVED' THEN       -- missing request: the FK reports it (23503)
    RAISE EXCEPTION 'a loan requires an APPROVED request (found %)', v_status
      USING ERRCODE = 'LD007';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_loans_before_insert BEFORE INSERT ON loans
  FOR EACH ROW EXECUTE FUNCTION fn_loans_before_insert();

-- T-D: a loan's identity and terms are immutable once created; returned_at is write-once.
-- Plain BEFORE UPDATE (not "OF col"), so every column is covered, including id.
CREATE FUNCTION fn_loans_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id          IS DISTINCT FROM OLD.id
  OR NEW.request_id  IS DISTINCT FROM OLD.request_id
  OR NEW.copy_id     IS DISTINCT FROM OLD.copy_id
  OR NEW.borrower_id IS DISTINCT FROM OLD.borrower_id
  OR NEW.lender_id   IS DISTINCT FROM OLD.lender_id
  OR NEW.borrowed_at IS DISTINCT FROM OLD.borrowed_at
  OR NEW.due_at      IS DISTINCT FROM OLD.due_at THEN
    RAISE EXCEPTION 'loan identity and terms are immutable once created' USING ERRCODE = 'LD011';
  END IF;
  IF OLD.returned_at IS NOT NULL AND NEW.returned_at IS DISTINCT FROM OLD.returned_at THEN
    RAISE EXCEPTION 'returned_at is write-once' USING ERRCODE = 'LD008';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_loans_before_update BEFORE UPDATE ON loans
  FOR EACH ROW EXECUTE FUNCTION fn_loans_before_update();

-- T-E: copy ownership is immutable (no transfers in v1).
CREATE FUNCTION fn_copies_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id <> OLD.owner_id THEN
    RAISE EXCEPTION 'copy ownership cannot be changed' USING ERRCODE = 'LD009';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_copies_before_update BEFORE UPDATE OF owner_id ON copies
  FOR EACH ROW EXECUTE FUNCTION fn_copies_before_update();

-- T-F: only returned loans can be reviewed.
CREATE FUNCTION fn_reviews_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_returned TIMESTAMPTZ;
BEGIN
  SELECT returned_at INTO v_returned FROM loans WHERE id = NEW.loan_id;
  IF FOUND AND v_returned IS NULL THEN           -- missing loan: the FK reports it (23503)
    RAISE EXCEPTION 'only returned loans can be reviewed' USING ERRCODE = 'LD010';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_reviews_before_insert BEFORE INSERT ON reviews
  FOR EACH ROW EXECUTE FUNCTION fn_reviews_before_insert();

-- T-G (added during the Phase 1 consistency pass): commit-time pairing of request and loan.
-- The immediate triggers above cannot stop a transaction from inserting a loan and committing
-- WITHOUT flipping its request to FULFILLED, which would leave an APPROVED request next to an
-- active loan (the exact state C-1 exists to prevent). Checked at COMMIT (or SET CONSTRAINTS IMMEDIATE):
--   loan exists  <=>  request.status = 'FULFILLED'
CREATE FUNCTION fn_request_loan_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_request  UUID;
  v_status   TEXT;
  v_has_loan BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'loans' THEN v_request := NEW.request_id; ELSE v_request := NEW.id; END IF;
  SELECT status INTO v_status FROM borrow_requests WHERE id = v_request;
  SELECT EXISTS (SELECT 1 FROM loans WHERE request_id = v_request) INTO v_has_loan;
  IF v_has_loan AND v_status IS DISTINCT FROM 'FULFILLED' THEN
    RAISE EXCEPTION 'a loan exists for request % but its status is % (must be FULFILLED)', v_request, v_status
      USING ERRCODE = 'LD012';
  ELSIF NOT v_has_loan AND v_status = 'FULFILLED' THEN
    RAISE EXCEPTION 'request % is FULFILLED but has no loan', v_request USING ERRCODE = 'LD006';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ctrg_request_fulfilment
  AFTER INSERT OR UPDATE OF status ON borrow_requests
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_request_loan_consistency();
CREATE CONSTRAINT TRIGGER ctrg_loan_fulfilment
  AFTER INSERT ON loans
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_request_loan_consistency();
