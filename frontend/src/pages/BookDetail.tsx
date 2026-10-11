import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getBook, listCopies, listRequests, listReviews, requestCopy } from '../api/endpoints';
import { ApiError } from '../api/client';
import type { Copy } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Cover } from '../components/Cover';
import { CopyCard } from '../components/CopyCard';
import { Pagination } from '../components/Pagination';
import { RequestDialog } from '../components/RequestDialog';
import { EmptyState, ErrorState, LoadingState, Notice } from '../components/States';
import { Stars } from '../components/Stars';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { copyViewState, openRequestCopyIds } from '../lib/copies';
import { authorLine, formatDate, plural } from '../lib/format';
import { friendlyMessage } from '../lib/messages';

const REVIEWS_PER_PAGE = 5;

export default function BookDetail() {
  const { bookId = '' } = useParams();
  // Keyed so review page, open dialog and notices never carry over from one book to the next.
  return <BookDetailView key={bookId} bookId={bookId} />;
}

function BookDetailView({ bookId }: { bookId: string }) {
  const { user } = useAuth();
  const [reviewOffset, setReviewOffset] = useState(0);
  const [target, setTarget] = useState<Copy | null>(null);
  const [sending, setSending] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const book = useAsync((s) => getBook(bookId, s), [bookId]);
  const copies = useAsync((s) => listCopies(bookId, s), [bookId]);
  // Only members have requests; anonymous visitors never call this protected endpoint.
  const mine = useAsync((s) => (user ? listRequests({ role: 'requester', limit: 100 }, s) : Promise.resolve(null)), [user?.id]);
  const reviews = useAsync((s) => listReviews(bookId, REVIEWS_PER_PAGE, reviewOffset, s), [bookId, reviewOffset]);

  useDocumentTitle(book.data?.title ?? 'Book');
  const requestedIds = useMemo(() => openRequestCopyIds(mine.data?.items ?? []), [mine.data]);

  const send = async (message: string) => {
    if (!target || sending) return;
    setSending(true);
    setDialogError(null);
    try {
      await requestCopy(target.id, message || null);
      setNotice({ tone: 'success', text: `Request sent to ${target.owner.displayName}. You will see its status in My Requests.` });
      setTarget(null);
      copies.reload();
      mine.reload();
    } catch (e) {
      setDialogError(friendlyMessage(e));
      // The copy may have been taken or hidden meanwhile: show its latest state.
      if (e instanceof ApiError && (e.status === 404 || e.status === 409)) copies.reload();
    } finally {
      setSending(false);
    }
  };

  if (book.loading && !book.data) return <div className="container page"><LoadingState label="Opening book…" /></div>;
  if (book.error) {
    return (
      <div className="container page">
        {book.error.status === 404
          ? <EmptyState title="We couldn’t find that book" action={<Link className="btn btn--primary" to="/books">Browse books</Link>}>
              It may have been removed, or the link is incorrect.
            </EmptyState>
          : <ErrorState error={book.error} onRetry={book.reload} />}
      </div>
    );
  }
  const b = book.data;
  if (!b) return null;
  const authors = authorLine(b.authors);

  return (
    <div className="container page">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/books">Books</Link>
        {b.genres[0] && <><span aria-hidden="true">›</span><Link to={`/books?genreId=${b.genres[0].id}`}>{b.genres[0].name}</Link></>}
        <span aria-hidden="true">›</span><span aria-current="page">{b.title}</span>
      </nav>

      {notice && <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Notice>}

      <div className="detail">
        <div className="detail__cover"><Cover title={b.title} authors={authors} size="lg" /></div>

        <div className="detail__main">
          <h1>{b.title}</h1>
          {authors && <p className="detail__authors">by {authors}</p>}
          {b.averageRating !== null
            ? <Stars value={b.averageRating} count={b.reviewCount} />
            : <p className="muted">No reviews yet</p>}
          {b.genres.length > 0 && (
            <ul className="chips" aria-label="Genres">
              {b.genres.map((g) => <li key={g.id}><Link className="chip" to={`/books?genreId=${g.id}`}>{g.name}</Link></li>)}
            </ul>
          )}
          {b.description && <p className="detail__desc">{b.description}</p>}

          <h2 className="detail__sub">About this book</h2>
          <dl className="facts">
            {b.publisher && <><dt>Publisher</dt><dd>{b.publisher}</dd></>}
            {b.publicationYear && <><dt>Published</dt><dd>{b.publicationYear}</dd></>}
            {b.edition && <><dt>Edition</dt><dd>{b.edition}</dd></>}
            {b.isbn && <><dt>ISBN</dt><dd>{b.isbn}</dd></>}
            <dt>Added</dt><dd>{formatDate(b.createdAt)}</dd>
          </dl>
        </div>

        <aside className="detail__copies" aria-labelledby="copies-h">
          <h2 id="copies-h">Copies ({copies.data?.length ?? '…'})</h2>
          {b.availableCopies > 0
            ? <p className="muted">{plural(b.availableCopies, 'copy', 'copies')} available to borrow.</p>
            : <p className="muted">No copy is available right now.</p>}
          {copies.loading && !copies.data ? <LoadingState label="Loading copies…" />
            : copies.error ? <ErrorState error={copies.error} onRetry={copies.reload} />
            : copies.data && copies.data.length > 0 ? (
              <ul className="copy-list">
                {copies.data.map((c) => (
                  <CopyCard key={c.id} copy={c} signedIn={!!user} busy={sending && target?.id === c.id}
                    state={copyViewState(c, user?.id ?? null, requestedIds)}
                    onRequest={(copy) => { setDialogError(null); setTarget(copy); }} />
                ))}
              </ul>
            ) : (
              <EmptyState title="No one has shared this title yet"
                action={<Link className="btn btn--primary" to="/list">Share your copy</Link>}>
                Own a copy? Be the first to list it.
              </EmptyState>
            )}
        </aside>
      </div>

      <section className="reviews" aria-labelledby="rev-h">
        <div className="section__head">
          <h2 id="rev-h" className="section__title">Reviews ({b.reviewCount})</h2>
          <p className="muted">Reviews come from members who borrowed and returned this book.</p>
        </div>
        {reviews.loading && !reviews.data ? <LoadingState label="Loading reviews…" />
          : reviews.error ? <ErrorState error={reviews.error} onRetry={reviews.reload} />
          : reviews.data && reviews.data.items.length > 0 ? (
            <>
              <ul className="review-list">
                {reviews.data.items.map((r) => (
                  <li key={r.id} className="review">
                    <div className="review__head"><strong>{r.reviewerName}</strong><time dateTime={r.createdAt}>{formatDate(r.createdAt)}</time></div>
                    <Stars value={r.rating} />
                    {r.comment && <p>{r.comment}</p>}
                  </li>
                ))}
              </ul>
              <Pagination page={reviews.data.page} onChange={setReviewOffset} />
            </>
          ) : <EmptyState title="No reviews yet">Borrow this book and be the first to review it.</EmptyState>}
      </section>

      <RequestDialog copy={target} busy={sending} error={dialogError} onCancel={() => setTarget(null)} onSubmit={send} />
    </div>
  );
}
