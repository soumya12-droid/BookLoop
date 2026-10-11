import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { listLoans, listRequests, myCopies } from '../api/endpoints';
import type { BorrowRequest } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge, DueBadge, RequestStatusBadge } from '../components/Badges';
import { Cover } from '../components/Cover';
import { BookIcon, HourglassIcon, InboxIcon, PlusIcon, StackIcon } from '../components/Icons';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { dueInfo, formatDate, formatDueDate } from '../lib/format';

function Stat({ icon, value, label, to }: { icon: ReactNode; value: number | string; label: string; to: string }) {
  return (
    <Link to={to} className="stat">
      <span className="stat__icon">{icon}</span>
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
    </Link>
  );
}

export default function Dashboard() {
  useDocumentTitle('My Books');
  const { user } = useAuth();

  // Counts are the server's own totals (page.total), never guessed from a partial list.
  const pendingMine = useAsync((s) => listRequests({ role: 'requester', status: 'PENDING', limit: 3 }, s), []);
  const incoming = useAsync((s) => listRequests({ role: 'owner', status: 'PENDING', limit: 1 }, s), []);
  const borrowing = useAsync((s) => listLoans({ role: 'borrower', status: 'active', limit: 3 }, s), []);
  const lending = useAsync((s) => listLoans({ role: 'lender', status: 'active', limit: 1 }, s), []);
  const copies = useAsync((s) => myCopies(s), []);
  const recentMine = useAsync((s) => listRequests({ role: 'requester', limit: 5 }, s), []);
  const recentIncoming = useAsync((s) => listRequests({ role: 'owner', limit: 5 }, s), []);

  const total = (r: { data: { page: { total: number } } | null }) => (r.data ? r.data.page.total : '…');

  const activity: { r: BorrowRequest; mine: boolean }[] = [
    ...(recentMine.data?.items ?? []).map((r) => ({ r, mine: true })),
    ...(recentIncoming.data?.items ?? []).map((r) => ({ r, mine: false })),
  ].sort((a, b) => b.r.createdAt.localeCompare(a.r.createdAt)).slice(0, 5);

  return (
    <div className="dash">
      <header className="dash__head">
        <div>
          <h1>My Books</h1>
          <p className="muted">Track your requests, loans and listings{user ? `, ${user.displayName.split(' ')[0]}` : ''}.</p>
        </div>
        <Link to="/list" className="btn btn--primary"><PlusIcon width={18} height={18} /> List a book</Link>
      </header>

      <div className="stats">
        <Stat to="/my/requests" icon={<HourglassIcon />} value={total(pendingMine)} label="Pending requests" />
        <Stat to="/my/loans" icon={<BookIcon />} value={total(borrowing)} label="Active loans" />
        <Stat to="/my/loans?tab=lent" icon={<StackIcon />} value={total(lending)} label="Books I’m lending" />
        <Stat to="/my/requests?tab=incoming" icon={<InboxIcon />} value={total(incoming)} label="Requests to review" />
      </div>

      <div className="dash__grid">
        <section className="panel" aria-labelledby="dr-h">
          <div className="panel__head"><h2 id="dr-h">My requests</h2><Link className="textlink" to="/my/requests">View all</Link></div>
          {pendingMine.loading && !pendingMine.data ? <LoadingState />
            : pendingMine.error ? <ErrorState error={pendingMine.error} onRetry={pendingMine.reload} />
            : pendingMine.data && pendingMine.data.items.length > 0 ? (
              <ul className="rows">
                {pendingMine.data.items.map((r) => (
                  <li key={r.id} className="row">
                    <Cover title={r.copy.bookTitle} size="sm" />
                    <div className="row__main">
                      <Link to={`/books/${r.copy.bookId}`} className="row__title">{r.copy.bookTitle}</Link>
                      <p className="muted">From {r.owner.displayName} · requested {formatDate(r.createdAt)}</p>
                    </div>
                    <RequestStatusBadge status={r.status} />
                  </li>
                ))}
              </ul>
            ) : <EmptyState title="No pending requests"><Link to="/books">Find a book to borrow</Link></EmptyState>}
        </section>

        <section className="panel" aria-labelledby="dl-h">
          <div className="panel__head"><h2 id="dl-h">My current loans</h2><Link className="textlink" to="/my/loans">View all</Link></div>
          {borrowing.loading && !borrowing.data ? <LoadingState />
            : borrowing.error ? <ErrorState error={borrowing.error} onRetry={borrowing.reload} />
            : borrowing.data && borrowing.data.items.length > 0 ? (
              <ul className="rows">
                {borrowing.data.items.map((l) => {
                  const due = dueInfo(l.dueAt, l.returnedAt, l.isOverdue);
                  return (
                    <li key={l.id} className="row">
                      <Cover title={l.copy.bookTitle} size="sm" />
                      <div className="row__main">
                        <Link to={`/books/${l.copy.bookId}`} className="row__title">{l.copy.bookTitle}</Link>
                        <p className="muted">From {l.lender.displayName} · due {formatDueDate(l.dueAt)}</p>
                      </div>
                      <DueBadge tone={due.tone} text={due.text} />
                    </li>
                  );
                })}
              </ul>
            ) : <EmptyState title="You aren’t borrowing anything">Approved requests become loans once the book is handed over.</EmptyState>}
        </section>

        <section className="panel" aria-labelledby="dli-h">
          <div className="panel__head"><h2 id="dli-h">My listings</h2><Link className="textlink" to="/my/listings">Manage</Link></div>
          {copies.loading && !copies.data ? <LoadingState />
            : copies.error ? <ErrorState error={copies.error} onRetry={copies.reload} />
            : copies.data && copies.data.length > 0 ? (
              <ul className="rows">
                {copies.data.slice(0, 4).map((c) => (
                  <li key={c.id} className="row">
                    <Cover title={c.bookTitle} size="sm" />
                    <div className="row__main">
                      <Link to={`/books/${c.bookId}`} className="row__title">{c.bookTitle}</Link>
                    </div>
                    {!c.isListed ? <Badge tone="muted">Not listed</Badge>
                      : c.available ? <Badge tone="available">Available</Badge>
                      : <Badge tone="unavailable">Out / reserved</Badge>}
                  </li>
                ))}
              </ul>
            ) : <EmptyState title="You haven’t listed a book yet" action={<Link className="btn btn--primary btn--sm" to="/list">List your first book</Link>} />}
        </section>

        <section className="panel" aria-labelledby="ra-h">
          <div className="panel__head"><h2 id="ra-h">Recent activity</h2></div>
          {activity.length > 0 ? (
            <ul className="timeline">
              {activity.map(({ r, mine }) => (
                <li key={r.id}>
                  <time dateTime={r.createdAt}>{formatDate(r.createdAt)}</time>
                  <span>
                    {mine ? <>You asked <strong>{r.owner.displayName}</strong> for </> : <><strong>{r.requester.displayName}</strong> asked for </>}
                    <Link to={`/books/${r.copy.bookId}`}>{r.copy.bookTitle}</Link>
                  </span>
                  <RequestStatusBadge status={r.status} />
                </li>
              ))}
            </ul>
          ) : (recentMine.loading || recentIncoming.loading) ? <LoadingState /> : <EmptyState title="Nothing yet">Requests you make and receive appear here.</EmptyState>}
        </section>
      </div>
    </div>
  );
}
