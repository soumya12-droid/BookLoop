-- 0003_copies.sql
CREATE TABLE copies (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id         UUID        NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
  owner_id        UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  copy_condition  TEXT        NOT NULL DEFAULT 'GOOD',
  is_listed       BOOLEAN     NOT NULL DEFAULT TRUE,   -- owner intent, NOT availability (availability is a view)
  pickup_location TEXT,                                -- override; falls back to the owner's default
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_copies_condition CHECK (copy_condition IN ('NEW','LIKE_NEW','GOOD','FAIR','POOR')),
  -- Redundant with the PK for lookups; exists as the FK target that makes loans.lender_id = owner (D-2).
  CONSTRAINT uq_copies_id_owner  UNIQUE (id, owner_id)
);
