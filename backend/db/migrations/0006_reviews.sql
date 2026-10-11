-- 0006_reviews.sql
-- Policy D-4: the borrower of a returned loan may review the book once.
-- The reviewer is loans.borrower_id by construction, so no reviewer column is stored.
CREATE TABLE reviews (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id    UUID        NOT NULL REFERENCES loans(id) ON DELETE RESTRICT,
  rating     SMALLINT    NOT NULL,
  comment    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_reviews_loan    UNIQUE (loan_id),
  CONSTRAINT ck_reviews_rating  CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT ck_reviews_comment CHECK (comment IS NULL OR char_length(comment) <= 2000)
);
