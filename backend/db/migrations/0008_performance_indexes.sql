-- 0008_performance_indexes.sql
-- Non-constraint indexes. Each names the query it serves (docs/PROPOSED_SCHEMA_V1.md section 6).
CREATE INDEX ix_book_authors_author ON book_authors (author_id);                 -- books by author
CREATE INDEX ix_book_genres_genre   ON book_genres  (genre_id);                  -- genre filter, popular genres
CREATE INDEX ix_copies_book         ON copies       (book_id);                   -- copies of a title
CREATE INDEX ix_copies_owner        ON copies       (owner_id);                  -- "my listings"
CREATE INDEX ix_req_requester       ON borrow_requests (requester_id, created_at DESC); -- "my requests"
CREATE INDEX ix_req_copy            ON borrow_requests (copy_id);                -- per-copy history, incoming requests
CREATE INDEX ix_loans_borrower      ON loans (borrower_id, borrowed_at DESC);    -- borrower history
CREATE INDEX ix_loans_lender        ON loans (lender_id,   borrowed_at DESC);    -- lender history
-- Active / overdue lists. The predicate must be immutable: "due_at < now()" is not allowed here.
CREATE INDEX ix_loans_open_due      ON loans (due_at) WHERE returned_at IS NULL;
