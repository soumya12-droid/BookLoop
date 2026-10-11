-- 0002_users_catalog.sql
-- Identity and title-level catalogue. See docs/PROPOSED_SCHEMA_V1.md section 4.

CREATE TABLE users (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                   CITEXT      NOT NULL,
  password_hash           TEXT        NOT NULL,
  display_name            TEXT        NOT NULL,
  role                    TEXT        NOT NULL DEFAULT 'MEMBER',
  default_pickup_location TEXT,
  contact_info            TEXT,       -- shown only to the counterparty of an APPROVED request / active loan (D-6)
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_at          TIMESTAMPTZ,  -- NULL = active. No separate is_active flag (cannot contradict).
  CONSTRAINT uq_users_email        UNIQUE (email),
  CONSTRAINT ck_users_role         CHECK (role IN ('MEMBER','ADMIN')),
  CONSTRAINT ck_users_email_format CHECK (email::text ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  CONSTRAINT ck_users_name_len     CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 80),
  CONSTRAINT ck_users_deactivated  CHECK (deactivated_at IS NULL OR deactivated_at >= created_at)
);

CREATE TABLE books (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT        NOT NULL,
  isbn             TEXT,                 -- ISBN-13, digits only; normalised/validated by the application
  edition          TEXT,
  publisher        TEXT,
  publication_year SMALLINT,
  description      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_books_isbn  UNIQUE (isbn),  -- NULLs are distinct in PostgreSQL: optional ISBN works
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
