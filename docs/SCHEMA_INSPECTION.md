# Schema inspection (generated, read-only catalog queries)

PostgreSQL: PostgreSQL 18.6 (c021049) on aarch64-unknown-linux-gnu, compiled by gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0, 64-bit
Extensions: citext 1.8, plpgsql 1.0

## Applied migrations
- 0001  0001_extensions.sql
- 0002  0002_users_catalog.sql
- 0003  0003_copies.sql
- 0004  0004_borrow_requests.sql
- 0005  0005_loans.sql
- 0006  0006_reviews.sql
- 0007  0007_guard_triggers.sql
- 0008  0008_performance_indexes.sql
- 0009  0009_views.sql

## Tables and row counts
- authors: 13
- book_authors: 28
- book_genres: 32
- books: 25
- borrow_requests: 31
- copies: 35
- genres: 12
- loans: 17
- reviews: 6
- schema_migrations: 9
- users: 12

## Constraints

### authors
- [CHECK] ck_authors_name: CHECK ((char_length(btrim(name)) > 0))
- [PRIMARY KEY] authors_pkey: PRIMARY KEY (id)
- [n] authors_id_not_null: NOT NULL id
- [n] authors_name_not_null: NOT NULL name

### book_authors
- [CHECK] ck_book_authors_order: CHECK ((author_order >= 1))
- [FOREIGN KEY] book_authors_author_id_fkey: FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE RESTRICT
- [FOREIGN KEY] book_authors_book_id_fkey: FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
- [PRIMARY KEY] book_authors_pkey: PRIMARY KEY (book_id, author_id)
- [UNIQUE] uq_book_authors_order: UNIQUE (book_id, author_order)
- [n] book_authors_author_id_not_null: NOT NULL author_id
- [n] book_authors_author_order_not_null: NOT NULL author_order
- [n] book_authors_book_id_not_null: NOT NULL book_id

### book_genres
- [FOREIGN KEY] book_genres_book_id_fkey: FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
- [FOREIGN KEY] book_genres_genre_id_fkey: FOREIGN KEY (genre_id) REFERENCES genres(id) ON DELETE RESTRICT
- [PRIMARY KEY] book_genres_pkey: PRIMARY KEY (book_id, genre_id)
- [n] book_genres_book_id_not_null: NOT NULL book_id
- [n] book_genres_genre_id_not_null: NOT NULL genre_id

### books
- [CHECK] ck_books_isbn: CHECK (((isbn IS NULL) OR (isbn ~ '^97[89][0-9]{10}$'::text)))
- [CHECK] ck_books_title: CHECK ((char_length(btrim(title)) > 0))
- [CHECK] ck_books_year: CHECK (((publication_year IS NULL) OR ((publication_year >= 1400) AND (publication_year <= 2100))))
- [PRIMARY KEY] books_pkey: PRIMARY KEY (id)
- [UNIQUE] uq_books_isbn: UNIQUE (isbn)
- [n] books_created_at_not_null: NOT NULL created_at
- [n] books_id_not_null: NOT NULL id
- [n] books_title_not_null: NOT NULL title

### borrow_requests
- [CHECK] ck_req_columns: CHECK ((((status = 'PENDING'::text) AND (decided_at IS NULL) AND (cancelled_at IS NULL) AND (cancelled_by IS NULL)) OR ((status = ANY (ARRAY['APPROVED'::text, 'REJECTED'::text, 'FULFILLED'::text])) AND (decided_at IS NOT NULL) AND (cancelled_at IS NULL) AND (cancelled_by IS NULL)) OR ((status = 'CANCELLED'::text) AND (cancelled_at IS NOT NULL) AND (cancelled_by IS NOT NULL))))
- [CHECK] ck_req_message: CHECK (((message IS NULL) OR (char_length(message) <= 500)))
- [CHECK] ck_req_status: CHECK ((status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'CANCELLED'::text, 'FULFILLED'::text])))
- [CHECK] ck_req_time_order: CHECK ((((decided_at IS NULL) OR (decided_at >= created_at)) AND ((cancelled_at IS NULL) OR (cancelled_at >= created_at)) AND ((decided_at IS NULL) OR (cancelled_at IS NULL) OR (cancelled_at >= decided_at))))
- [FOREIGN KEY] borrow_requests_cancelled_by_fkey: FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE RESTRICT
- [FOREIGN KEY] borrow_requests_copy_id_fkey: FOREIGN KEY (copy_id) REFERENCES copies(id) ON DELETE RESTRICT
- [FOREIGN KEY] borrow_requests_requester_id_fkey: FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE RESTRICT
- [PRIMARY KEY] borrow_requests_pkey: PRIMARY KEY (id)
- [UNIQUE] uq_req_match: UNIQUE (id, copy_id, requester_id)
- [n] borrow_requests_copy_id_not_null: NOT NULL copy_id
- [n] borrow_requests_created_at_not_null: NOT NULL created_at
- [n] borrow_requests_id_not_null: NOT NULL id
- [n] borrow_requests_requester_id_not_null: NOT NULL requester_id
- [n] borrow_requests_status_not_null: NOT NULL status
- [t] ctrg_request_fulfilment: TRIGGER DEFERRABLE INITIALLY DEFERRED

### copies
- [CHECK] ck_copies_condition: CHECK ((copy_condition = ANY (ARRAY['NEW'::text, 'LIKE_NEW'::text, 'GOOD'::text, 'FAIR'::text, 'POOR'::text])))
- [FOREIGN KEY] copies_book_id_fkey: FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE RESTRICT
- [FOREIGN KEY] copies_owner_id_fkey: FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT
- [PRIMARY KEY] copies_pkey: PRIMARY KEY (id)
- [UNIQUE] uq_copies_id_owner: UNIQUE (id, owner_id)
- [n] copies_book_id_not_null: NOT NULL book_id
- [n] copies_copy_condition_not_null: NOT NULL copy_condition
- [n] copies_created_at_not_null: NOT NULL created_at
- [n] copies_id_not_null: NOT NULL id
- [n] copies_is_listed_not_null: NOT NULL is_listed
- [n] copies_owner_id_not_null: NOT NULL owner_id
- [n] copies_updated_at_not_null: NOT NULL updated_at

### genres
- [CHECK] ck_genres_name: CHECK ((char_length(btrim(name)) > 0))
- [PRIMARY KEY] genres_pkey: PRIMARY KEY (id)
- [n] genres_id_not_null: NOT NULL id
- [n] genres_name_not_null: NOT NULL name

### loans
- [CHECK] ck_loans_due: CHECK ((due_at > borrowed_at))
- [CHECK] ck_loans_not_self: CHECK ((borrower_id <> lender_id))
- [CHECK] ck_loans_returned: CHECK (((returned_at IS NULL) OR (returned_at >= borrowed_at)))
- [FOREIGN KEY] fk_loans_copy_owner: FOREIGN KEY (copy_id, lender_id) REFERENCES copies(id, owner_id)
- [FOREIGN KEY] fk_loans_request_match: FOREIGN KEY (request_id, copy_id, borrower_id) REFERENCES borrow_requests(id, copy_id, requester_id)
- [PRIMARY KEY] loans_pkey: PRIMARY KEY (id)
- [UNIQUE] uq_loans_request: UNIQUE (request_id)
- [n] loans_borrowed_at_not_null: NOT NULL borrowed_at
- [n] loans_borrower_id_not_null: NOT NULL borrower_id
- [n] loans_copy_id_not_null: NOT NULL copy_id
- [n] loans_due_at_not_null: NOT NULL due_at
- [n] loans_id_not_null: NOT NULL id
- [n] loans_lender_id_not_null: NOT NULL lender_id
- [n] loans_request_id_not_null: NOT NULL request_id
- [t] ctrg_loan_fulfilment: TRIGGER DEFERRABLE INITIALLY DEFERRED

### reviews
- [CHECK] ck_reviews_comment: CHECK (((comment IS NULL) OR (char_length(comment) <= 2000)))
- [CHECK] ck_reviews_rating: CHECK (((rating >= 1) AND (rating <= 5)))
- [FOREIGN KEY] reviews_loan_id_fkey: FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE RESTRICT
- [PRIMARY KEY] reviews_pkey: PRIMARY KEY (id)
- [UNIQUE] uq_reviews_loan: UNIQUE (loan_id)
- [n] reviews_created_at_not_null: NOT NULL created_at
- [n] reviews_id_not_null: NOT NULL id
- [n] reviews_loan_id_not_null: NOT NULL loan_id
- [n] reviews_rating_not_null: NOT NULL rating

### schema_migrations
- [PRIMARY KEY] schema_migrations_pkey: PRIMARY KEY (version)
- [n] schema_migrations_applied_at_not_null: NOT NULL applied_at
- [n] schema_migrations_checksum_not_null: NOT NULL checksum
- [n] schema_migrations_name_not_null: NOT NULL name
- [n] schema_migrations_version_not_null: NOT NULL version

### users
- [CHECK] ck_users_deactivated: CHECK (((deactivated_at IS NULL) OR (deactivated_at >= created_at)))
- [CHECK] ck_users_email_format: CHECK (((email)::text ~ '^[^@[:space:]]+@[^@[:space:]]+$'::text))
- [CHECK] ck_users_name_len: CHECK (((char_length(btrim(display_name)) >= 1) AND (char_length(btrim(display_name)) <= 80)))
- [CHECK] ck_users_role: CHECK ((role = ANY (ARRAY['MEMBER'::text, 'ADMIN'::text])))
- [PRIMARY KEY] users_pkey: PRIMARY KEY (id)
- [UNIQUE] uq_users_email: UNIQUE (email)
- [n] users_created_at_not_null: NOT NULL created_at
- [n] users_display_name_not_null: NOT NULL display_name
- [n] users_email_not_null: NOT NULL email
- [n] users_id_not_null: NOT NULL id
- [n] users_password_hash_not_null: NOT NULL password_hash
- [n] users_role_not_null: NOT NULL role

## Indexes

### authors
- authors_pkey: CREATE UNIQUE INDEX authors_pkey ON public.authors USING btree (id)
- uq_authors_name: CREATE UNIQUE INDEX uq_authors_name ON public.authors USING btree (lower(name))

### book_authors
- book_authors_pkey: CREATE UNIQUE INDEX book_authors_pkey ON public.book_authors USING btree (book_id, author_id)
- ix_book_authors_author: CREATE INDEX ix_book_authors_author ON public.book_authors USING btree (author_id)
- uq_book_authors_order: CREATE UNIQUE INDEX uq_book_authors_order ON public.book_authors USING btree (book_id, author_order)

### book_genres
- book_genres_pkey: CREATE UNIQUE INDEX book_genres_pkey ON public.book_genres USING btree (book_id, genre_id)
- ix_book_genres_genre: CREATE INDEX ix_book_genres_genre ON public.book_genres USING btree (genre_id)

### books
- books_pkey: CREATE UNIQUE INDEX books_pkey ON public.books USING btree (id)
- uq_books_isbn: CREATE UNIQUE INDEX uq_books_isbn ON public.books USING btree (isbn)

### borrow_requests
- borrow_requests_pkey: CREATE UNIQUE INDEX borrow_requests_pkey ON public.borrow_requests USING btree (id)
- ix_req_copy: CREATE INDEX ix_req_copy ON public.borrow_requests USING btree (copy_id)
- ix_req_requester: CREATE INDEX ix_req_requester ON public.borrow_requests USING btree (requester_id, created_at DESC)
- uq_req_match: CREATE UNIQUE INDEX uq_req_match ON public.borrow_requests USING btree (id, copy_id, requester_id)
- uq_req_one_approved_per_copy: CREATE UNIQUE INDEX uq_req_one_approved_per_copy ON public.borrow_requests USING btree (copy_id) WHERE (status = 'APPROVED'::text)
- uq_req_one_open_per_member_copy: CREATE UNIQUE INDEX uq_req_one_open_per_member_copy ON public.borrow_requests USING btree (copy_id, requester_id) WHERE (status = ANY (ARRAY['PENDING'::text, 'APPROVED'::text]))

### copies
- copies_pkey: CREATE UNIQUE INDEX copies_pkey ON public.copies USING btree (id)
- ix_copies_book: CREATE INDEX ix_copies_book ON public.copies USING btree (book_id)
- ix_copies_owner: CREATE INDEX ix_copies_owner ON public.copies USING btree (owner_id)
- uq_copies_id_owner: CREATE UNIQUE INDEX uq_copies_id_owner ON public.copies USING btree (id, owner_id)

### genres
- genres_pkey: CREATE UNIQUE INDEX genres_pkey ON public.genres USING btree (id)
- uq_genres_name: CREATE UNIQUE INDEX uq_genres_name ON public.genres USING btree (lower(name))

### loans
- ix_loans_borrower: CREATE INDEX ix_loans_borrower ON public.loans USING btree (borrower_id, borrowed_at DESC)
- ix_loans_lender: CREATE INDEX ix_loans_lender ON public.loans USING btree (lender_id, borrowed_at DESC)
- ix_loans_open_due: CREATE INDEX ix_loans_open_due ON public.loans USING btree (due_at) WHERE (returned_at IS NULL)
- loans_pkey: CREATE UNIQUE INDEX loans_pkey ON public.loans USING btree (id)
- uq_loans_one_active_per_copy: CREATE UNIQUE INDEX uq_loans_one_active_per_copy ON public.loans USING btree (copy_id) WHERE (returned_at IS NULL)
- uq_loans_request: CREATE UNIQUE INDEX uq_loans_request ON public.loans USING btree (request_id)

### reviews
- reviews_pkey: CREATE UNIQUE INDEX reviews_pkey ON public.reviews USING btree (id)
- uq_reviews_loan: CREATE UNIQUE INDEX uq_reviews_loan ON public.reviews USING btree (loan_id)

### schema_migrations
- schema_migrations_pkey: CREATE UNIQUE INDEX schema_migrations_pkey ON public.schema_migrations USING btree (version)

### users
- uq_users_email: CREATE UNIQUE INDEX uq_users_email ON public.users USING btree (email)
- users_pkey: CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)

## Triggers
- borrow_requests.ctrg_request_fulfilment [DEFERRABLE INITIALLY DEFERRED]
- borrow_requests.trg_requests_before_insert
- borrow_requests.trg_requests_before_update
- copies.trg_copies_before_update
- loans.ctrg_loan_fulfilment [DEFERRABLE INITIALLY DEFERRED]
- loans.trg_loans_before_insert
- loans.trg_loans_before_update
- reviews.trg_reviews_before_insert

## Views
- active_loans
- available_copies
- member_activity
- most_borrowed_titles
- overdue_loans
- popular_genres
- request_funnel
- return_timeliness
