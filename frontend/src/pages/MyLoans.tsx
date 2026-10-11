import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { listLoans, returnLoan, reviewLoan } from '../api/endpoints';
import type { Loan } from '../api/types';
import { DueBadge } from '../components/Badges';
import { Cover } from '../components/Cover';
import { ConfirmButton, SelectField, TextArea } from '../components/Forms';
import { Pagination } from '../components/Pagination';
import { EmptyState, ErrorState, LoadingState, Notice } from '../components/States';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { dueInfo, formatDate, formatDueDate } from '../lib/format';
import { friendlyMessage } from '../lib/messages';

const PAGE = 10;

function ReviewForm({ busy, onSubmit, onCancel }: {
  busy: boolean; onSubmit: (rating: number, comment: string) => void; onCancel: () => void;
}) {
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); if (!busy) onSubmit(rating, comment.trim()); };
  return (
    <form className="review-form" onSubmit={submit}>
      <SelectField label="Your rating" value={rating} onChange={(e) => setRating(Number(e.target.value))}>
        {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} {n === 1 ? 'star' : 'stars'}</option>)}
      </SelectField>
      <TextArea label="Your review (optional)" rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
      <div className="inline-form">
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>{busy ? 'Saving…' : 'Post review'}</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

export default function MyLoans() {
  useDocumentTitle('My Loans');
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'lent' ? 'lent' : 'borrowed';
  // The page offset belongs to the tab it was set on, so a tab change (or back button) starts at page 1.
  const [pos, setPos] = useState({ tab, offset: 0 });
  const offset = pos.tab === tab ? pos.offset : 0;
  const setOffset = (o: number) => setPos({ tab, offset: o });
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const role = tab === 'lent' ? 'lender' : 'borrower';
  const list = useAsync((s) => listLoans({ role, limit: PAGE, offset }, s), [role, offset]);

  const doReturn = async (l: Loan) => {
    if (busy) return;
    setBusy(l.id); setNotice(null);
    try {
      await returnLoan(l.id);
      setNotice({ tone: 'success', text: `“${l.copy.bookTitle}” is recorded as returned. It is available to borrow again.` });
    } catch (e) {
      setNotice({ tone: 'error', text: friendlyMessage(e) });
    } finally {
      setBusy(null);
      list.reload();
    }
  };

  const doReview = async (l: Loan, rating: number, comment: string) => {
    if (busy) return;
    setBusy(l.id); setNotice(null);
    try {
      await reviewLoan(l.id, rating, comment || null);
      setReviewed((s) => new Set(s).add(l.id));
      setReviewing(null);
      setNotice({ tone: 'success', text: 'Thank you. Your review is now on the book’s page.' });
    } catch (e) {
      // The API has no “already reviewed” flag on a loan, so a duplicate surfaces here as a 409.
      const dup = (e as { code?: string }).code === 'ALREADY_REVIEWED';
      if (dup) { setReviewed((s) => new Set(s).add(l.id)); setReviewing(null); }
      setNotice({ tone: dup ? 'success' : 'error', text: friendlyMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const switchTab = (t: 'borrowed' | 'lent') => { setNotice(null); setParams(t === 'lent' ? { tab: 'lent' } : {}); };

  const items = list.data?.items ?? [];
  const active = items.filter((l) => !l.returnedAt);
  const past = items.filter((l) => l.returnedAt);

  const renderLoan = (l: Loan) => {
    const due = dueInfo(l.dueAt, l.returnedAt, l.isOverdue);
    const lent = tab === 'lent';
    return (
      <li key={l.id} className={`card-row${due.tone === 'overdue' ? ' card-row--overdue' : ''}`}>
        <Cover title={l.copy.bookTitle} size="sm" />
        <div className="card-row__main">
          <div className="card-row__top">
            <Link className="row__title" to={`/books/${l.copy.bookId}`}>{l.copy.bookTitle}</Link>
            <DueBadge tone={due.tone} text={due.text} />
          </div>
          <p className="muted">
            {lent ? <>Lent to <strong>{l.borrower.displayName}</strong></> : <>From <strong>{l.lender.displayName}</strong></>}
            {' · '}borrowed {formatDate(l.borrowedAt)}{!l.returnedAt && <> · due {formatDueDate(l.dueAt)}</>}
          </p>
          {l.counterpartyContact && (
            <p className="contact"><span>{lent ? 'Reach the borrower' : 'Reach the lender'}</span> {l.counterpartyContact}</p>
          )}
          {reviewing === l.id && (
            <ReviewForm busy={busy === l.id} onSubmit={(r, c) => doReview(l, r, c)} onCancel={() => setReviewing(null)} />
          )}
        </div>
        <div className="card-row__actions">
          {lent && !l.returnedAt && (
            <ConfirmButton label="Record return" confirmLabel="Yes, it’s back" tone="primary" busy={busy === l.id}
              onConfirm={() => doReturn(l)} />
          )}
          {!lent && !l.returnedAt && <p className="hint">Return it to its owner, who records the return.</p>}
          {!lent && l.returnedAt && (reviewed.has(l.id)
            ? <span className="hint">Reviewed ✓</span>
            : reviewing !== l.id && <button type="button" className="btn btn--ghost btn--sm" onClick={() => setReviewing(l.id)}>Write a review</button>)}
        </div>
      </li>
    );
  };

  return (
    <div className="dash">
      <header className="dash__head">
        <div>
          <h1>My Loans</h1>
          <p className="muted">Books you have borrowed, and books you have lent to others.</p>
        </div>
      </header>

      <div className="tabs" role="tablist" aria-label="Loan views">
        <button role="tab" aria-selected={tab === 'borrowed'} className={`tab${tab === 'borrowed' ? ' is-active' : ''}`} onClick={() => switchTab('borrowed')}>Books I’ve borrowed</button>
        <button role="tab" aria-selected={tab === 'lent'} className={`tab${tab === 'lent' ? ' is-active' : ''}`} onClick={() => switchTab('lent')}>Books I’ve lent</button>
      </div>

      {notice && <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Notice>}

      {list.loading && !list.data ? <LoadingState label="Loading loans…" />
        : list.error ? <ErrorState error={list.error} onRetry={list.reload} />
        : items.length > 0 ? (
          <>
            {active.length > 0 && (<><h2 className="group-title">Active</h2><ul className="cards">{active.map(renderLoan)}</ul></>)}
            {past.length > 0 && (<><h2 className="group-title">Returned</h2><ul className="cards">{past.map(renderLoan)}</ul></>)}
            {list.data && <Pagination page={list.data.page} onChange={setOffset} />}
          </>
        ) : (
          <EmptyState title={tab === 'lent' ? 'You haven’t lent a book yet' : 'You haven’t borrowed a book yet'}
            action={<Link className="btn btn--primary" to={tab === 'lent' ? '/my/requests?tab=incoming' : '/books'}>
              {tab === 'lent' ? 'See requests for your books' : 'Browse books'}</Link>}>
            {tab === 'lent' ? 'When you hand a book over, the loan appears here.' : 'Once an owner hands a book over, the loan appears here.'}
          </EmptyState>
        )}
    </div>
  );
}
