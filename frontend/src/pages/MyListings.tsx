import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { listRequests, myCopies, setCopyListed } from '../api/endpoints';
import type { Copy } from '../api/types';
import { Badge } from '../components/Badges';
import { Cover } from '../components/Cover';
import { PlusIcon } from '../components/Icons';
import { EmptyState, ErrorState, LoadingState, Notice } from '../components/States';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { CONDITION_LABEL } from '../lib/copies';
import { formatDate, plural } from '../lib/format';
import { friendlyMessage } from '../lib/messages';

export default function MyListings() {
  useDocumentTitle('My Listings');
  const copies = useAsync((s) => myCopies(s), []);
  // Pending requests for my copies, so each listing can say how many are waiting for a decision.
  const waiting = useAsync((s) => listRequests({ role: 'owner', status: 'PENDING', limit: 100 }, s), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const waitingByCopy = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of waiting.data?.items ?? []) m.set(r.copy.id, (m.get(r.copy.id) ?? 0) + 1);
    return m;
  }, [waiting.data]);

  const toggle = async (c: Copy) => {
    if (busy) return;
    setBusy(c.id); setNotice(null);
    try {
      await setCopyListed(c.id, !c.isListed);
      setNotice({ tone: 'success', text: c.isListed ? `“${c.bookTitle}” is no longer listed.` : `“${c.bookTitle}” is listed again.` });
    } catch (e) {
      setNotice({ tone: 'error', text: friendlyMessage(e) });
    } finally {
      setBusy(null);
      copies.reload();
    }
  };

  return (
    <div className="dash">
      <header className="dash__head">
        <div>
          <h1>My Listings</h1>
          <p className="muted">Copies you own. Unlist a copy to stop new requests.</p>
        </div>
        <Link to="/list" className="btn btn--primary"><PlusIcon width={18} height={18} /> List a book</Link>
      </header>

      {notice && <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Notice>}

      {copies.loading && !copies.data ? <LoadingState label="Loading your listings…" />
        : copies.error ? <ErrorState error={copies.error} onRetry={copies.reload} />
        : copies.data && copies.data.length > 0 ? (
          <ul className="cards">
            {copies.data.map((c) => {
              const n = waitingByCopy.get(c.id) ?? 0;
              return (
                <li key={c.id} className="card-row">
                  <Cover title={c.bookTitle} size="sm" />
                  <div className="card-row__main">
                    <div className="card-row__top">
                      <Link className="row__title" to={`/books/${c.bookId}`}>{c.bookTitle}</Link>
                      {!c.isListed ? <Badge tone="muted">Not listed</Badge>
                        : c.available ? <Badge tone="available">Available</Badge>
                        : <Badge tone="unavailable">On loan or reserved</Badge>}
                    </div>
                    <p className="muted">
                      {CONDITION_LABEL[c.condition] ?? c.condition}
                      {c.pickupLocation && <> · Pickup: {c.pickupLocation}</>}
                      {' · '}added {formatDate(c.createdAt)}
                    </p>
                    {c.notes && <p className="quote">{c.notes}</p>}
                    {n > 0 && <p className="hint"><Link to="/my/requests?tab=incoming">{plural(n, 'request')} waiting for your decision</Link></p>}
                  </div>
                  <div className="card-row__actions">
                    <button type="button" className="btn btn--ghost btn--sm" disabled={busy === c.id} onClick={() => toggle(c)}>
                      {busy === c.id ? 'Saving…' : c.isListed ? 'Unlist' : 'List again'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="You haven’t listed any books yet"
            action={<Link className="btn btn--primary" to="/list">List your first book</Link>}>
            Add a copy of a book you own so others can borrow it.
          </EmptyState>
        )}
    </div>
  );
}
