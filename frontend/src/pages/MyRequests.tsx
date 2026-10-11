import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { actOnRequest, handoff, listRequests, type RequestAction } from '../api/endpoints';
import type { BorrowRequest } from '../api/types';
import { RequestStatusBadge } from '../components/Badges';
import { ConfirmButton } from '../components/Forms';
import { Cover } from '../components/Cover';
import { Pagination } from '../components/Pagination';
import { EmptyState, ErrorState, LoadingState, Notice } from '../components/States';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { formatDate } from '../lib/format';
import { friendlyMessage } from '../lib/messages';

const PAGE = 10;

function Handoff({ busy, onSubmit }: { busy: boolean; onSubmit: (days: number) => void }) {
  const [days, setDays] = useState(14);
  return (
    <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (!busy) onSubmit(days); }}>
      <label>
        <span className="sr-only">Loan length in days</span>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={busy}>
          {[7, 14, 21, 28, 42, 60].map((d) => <option key={d} value={d}>{d} days</option>)}
        </select>
      </label>
      <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>{busy ? 'Saving…' : 'Record hand-over'}</button>
    </form>
  );
}

export default function MyRequests() {
  useDocumentTitle('My Requests');
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'incoming' ? 'incoming' : 'mine';
  // The page offset belongs to the tab it was set on, so a tab change (or back button) starts at page 1.
  const [pos, setPos] = useState({ tab, offset: 0 });
  const offset = pos.tab === tab ? pos.offset : 0;
  const setOffset = (o: number) => setPos({ tab, offset: o });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const role = tab === 'incoming' ? 'owner' : 'requester';
  const list = useAsync((s) => listRequests({ role, limit: PAGE, offset }, s), [role, offset]);

  const run = async (r: BorrowRequest, label: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(r.id);
    setNotice(null);
    try {
      await fn();
      setNotice({ tone: 'success', text: label });
      list.reload();
    } catch (e) {
      setNotice({ tone: 'error', text: friendlyMessage(e) });
      list.reload(); // the request may have changed; show its latest state
    } finally {
      setBusy(null);
    }
  };
  const act = (r: BorrowRequest, action: RequestAction, ok: string) => run(r, ok, () => actOnRequest(r.id, action));

  const switchTab = (t: 'mine' | 'incoming') => { setNotice(null); setParams(t === 'incoming' ? { tab: 'incoming' } : {}); };

  return (
    <div className="dash">
      <header className="dash__head">
        <div>
          <h1>My Requests</h1>
          <p className="muted">Ask to borrow, and decide on requests for your own copies.</p>
        </div>
      </header>

      <div className="tabs" role="tablist" aria-label="Request views">
        <button role="tab" aria-selected={tab === 'mine'} className={`tab${tab === 'mine' ? ' is-active' : ''}`} onClick={() => switchTab('mine')}>Requested by me</button>
        <button role="tab" aria-selected={tab === 'incoming'} className={`tab${tab === 'incoming' ? ' is-active' : ''}`} onClick={() => switchTab('incoming')}>Requests for my books</button>
      </div>

      {notice && <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Notice>}

      {list.loading && !list.data ? <LoadingState label="Loading requests…" />
        : list.error ? <ErrorState error={list.error} onRetry={list.reload} />
        : list.data && list.data.items.length > 0 ? (
          <>
            <ul className="cards">
              {list.data.items.map((r) => {
                const isBusy = busy === r.id;
                const incoming = tab === 'incoming';
                return (
                  <li key={r.id} className="card-row">
                    <Cover title={r.copy.bookTitle} size="sm" />
                    <div className="card-row__main">
                      <div className="card-row__top">
                        <Link className="row__title" to={`/books/${r.copy.bookId}`}>{r.copy.bookTitle}</Link>
                        <RequestStatusBadge status={r.status} />
                      </div>
                      <p className="muted">
                        {incoming ? <>Requested by <strong>{r.requester.displayName}</strong></> : <>Owner: <strong>{r.owner.displayName}</strong></>}
                        {' · '}{formatDate(r.createdAt)}
                      </p>
                      {r.message && <p className="quote">“{r.message}”</p>}
                      {r.counterpartyContact && (
                        <p className="contact"><span>{incoming ? 'Reach the borrower' : 'Reach the owner'}</span> {r.counterpartyContact}</p>
                      )}
                      {r.status === 'APPROVED' && !incoming && <p className="hint">Approved. Arrange the hand-over with the owner.</p>}
                      {r.status === 'FULFILLED' && r.loanId && <p className="hint"><Link to="/my/loans">See this loan</Link></p>}
                    </div>
                    <div className="card-row__actions">
                      {incoming && r.status === 'PENDING' && (
                        <>
                          <button type="button" className="btn btn--primary btn--sm" disabled={isBusy}
                            onClick={() => act(r, 'approve', `Approved ${r.requester.displayName}’s request.`)}>Approve</button>
                          <ConfirmButton label="Decline" confirmLabel="Yes, decline" busy={isBusy}
                            onConfirm={() => act(r, 'reject', 'Request declined.')} />
                        </>
                      )}
                      {incoming && r.status === 'APPROVED' && (
                        <>
                          <Handoff busy={isBusy} onSubmit={(days) => run(r, 'Hand-over recorded. The loan is now active.', () => handoff(r.id, days))} />
                          <ConfirmButton label="Cancel reservation" confirmLabel="Yes, cancel" busy={isBusy}
                            onConfirm={() => act(r, 'cancel', 'Reservation cancelled. The copy is available again.')} />
                        </>
                      )}
                      {!incoming && (r.status === 'PENDING' || r.status === 'APPROVED') && (
                        <ConfirmButton label="Cancel request" confirmLabel="Yes, cancel" busy={isBusy}
                          onConfirm={() => act(r, 'cancel', 'Request cancelled.')} />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <Pagination page={list.data.page} onChange={setOffset} />
          </>
        ) : (
          <EmptyState title={tab === 'incoming' ? 'No one has asked for your books yet' : 'You haven’t requested a book yet'}
            action={tab === 'incoming' ? <Link className="btn btn--primary" to="/list">List a book</Link> : <Link className="btn btn--primary" to="/books">Browse books</Link>}>
            {tab === 'incoming' ? 'Requests for your listed copies show up here.' : 'Find a title and ask its owner to lend it.'}
          </EmptyState>
        )}
    </div>
  );
}
