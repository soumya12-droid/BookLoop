-- 0009_views.sql
-- Availability is derived (D-1). PENDING requests and copy condition deliberately do not affect it.
-- The view is an advisory snapshot; the authoritative check is repeated under the copy lock.
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
FROM loans l
WHERE l.returned_at IS NULL;

CREATE VIEW overdue_loans AS
SELECT l.*
FROM loans l
WHERE l.returned_at IS NULL AND l.due_at < now();

-- Analytics. Metric definitions: docs/DATABASE_DESIGN_REVIEW.md section 5.5.
CREATE VIEW most_borrowed_titles AS
SELECT b.id AS book_id, b.title, COUNT(l.id) AS loan_count
FROM books b
JOIN copies c ON c.book_id = b.id
JOIN loans  l ON l.copy_id = c.id
GROUP BY b.id, b.title;

-- A book with several genres counts once in each of its genres.
CREATE VIEW popular_genres AS
SELECT g.id AS genre_id, g.name, COUNT(l.id) AS loan_count
FROM genres g
JOIN book_genres bg ON bg.genre_id = g.id
JOIN copies c       ON c.book_id = bg.book_id
JOIN loans  l       ON l.copy_id = c.id
GROUP BY g.id, g.name;

CREATE VIEW member_activity AS
SELECT u.id AS user_id, u.display_name, u.deactivated_at,
       (SELECT COUNT(*) FROM copies c WHERE c.owner_id    = u.id) AS copies_owned,
       (SELECT COUNT(*) FROM loans  l WHERE l.lender_id   = u.id) AS loans_lent,
       (SELECT COUNT(*) FROM loans  l WHERE l.borrower_id = u.id) AS loans_borrowed
FROM users u;

CREATE VIEW return_timeliness AS
SELECT COUNT(*) FILTER (WHERE returned_at IS NOT NULL)                        AS returned_loans,
       COUNT(*) FILTER (WHERE returned_at IS NOT NULL AND returned_at <= due_at) AS returned_on_time,
       COUNT(*) FILTER (WHERE returned_at IS NOT NULL AND returned_at >  due_at) AS returned_late,
       COUNT(*) FILTER (WHERE returned_at IS NULL)                            AS currently_active,
       COUNT(*) FILTER (WHERE returned_at IS NULL AND due_at < now())         AS currently_overdue
FROM loans;

-- decided_at IS NOT NULL on a CANCELLED row means the request had been approved first
-- (a REJECTED request keeps its own status).
CREATE VIEW request_funnel AS
SELECT COUNT(*)                                                         AS total_requests,
       COUNT(*) FILTER (WHERE status = 'PENDING')                       AS pending,
       COUNT(*) FILTER (WHERE status = 'REJECTED')                      AS rejected,
       COUNT(*) FILTER (WHERE status IN ('APPROVED','FULFILLED')
                          OR (status = 'CANCELLED' AND decided_at IS NOT NULL)) AS ever_approved,
       COUNT(*) FILTER (WHERE status = 'FULFILLED')                     AS fulfilled,
       COUNT(*) FILTER (WHERE status = 'CANCELLED' AND decided_at IS NULL)       AS withdrawn_while_pending,
       COUNT(*) FILTER (WHERE status = 'CANCELLED' AND decided_at IS NOT NULL
                          AND cancelled_by =  requester_id)             AS withdrawn_after_approval,
       COUNT(*) FILTER (WHERE status = 'CANCELLED' AND decided_at IS NOT NULL
                          AND cancelled_by <> requester_id)             AS cancelled_after_approval_by_other
FROM borrow_requests;
