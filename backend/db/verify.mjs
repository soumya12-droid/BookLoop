// Read-only sanity report on the seeded TEST branch: availability, overdue and analytics views.
import { connectTest } from './lib/env.mjs';

const c = await connectTest();
const show = async (title, sql) => {
  const r = await c.query(sql);
  console.log(`\n== ${title}`);
  console.table(r.rows);
};
try {
  await show('request status distribution',
    `SELECT status, count(*)::int AS n FROM borrow_requests GROUP BY 1 ORDER BY 1`);
  await show('available_copies vs total copies',
    `SELECT (SELECT count(*)::int FROM available_copies) AS available, (SELECT count(*)::int FROM copies) AS copies`);
  await show('active_loans',
    `SELECT count(*)::int AS active, count(*) FILTER (WHERE is_overdue)::int AS overdue FROM active_loans`);
  await show('overdue_loans (returned_in_view must be 0)',
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE returned_at IS NOT NULL)::int AS returned_in_view FROM overdue_loans`);
  await show('return_timeliness', `SELECT * FROM return_timeliness`);
  await show('request_funnel', `SELECT * FROM request_funnel`);
  await show('most_borrowed_titles (top 5)',
    `SELECT title, loan_count FROM most_borrowed_titles ORDER BY loan_count DESC, title LIMIT 5`);
  await show('popular_genres (top 5)',
    `SELECT name, loan_count FROM popular_genres ORDER BY loan_count DESC, name LIMIT 5`);
  await show('copies wrongly present in available_copies (must be 0)', `
    SELECT count(*)::int AS leaked FROM available_copies a
    WHERE EXISTS (SELECT 1 FROM loans l WHERE l.copy_id = a.copy_id AND l.returned_at IS NULL)
       OR EXISTS (SELECT 1 FROM borrow_requests r WHERE r.copy_id = a.copy_id AND r.status = 'APPROVED')
       OR EXISTS (SELECT 1 FROM copies x WHERE x.id = a.copy_id AND NOT x.is_listed)
       OR EXISTS (SELECT 1 FROM copies x JOIN users u ON u.id = x.owner_id
                  WHERE x.id = a.copy_id AND u.deactivated_at IS NOT NULL)`);
} finally {
  await c.end();
}
