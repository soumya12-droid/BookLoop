import type { PageInfo } from '../api/types';

export function Pagination({ page, onChange }: { page: PageInfo; onChange: (offset: number) => void }) {
  const { limit, offset, total } = page;
  if (total <= limit) return null;
  const current = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <nav className="pagination" aria-label="Pagination">
      <button type="button" className="btn btn--ghost" disabled={offset <= 0}
        onClick={() => onChange(Math.max(0, offset - limit))}>← Previous</button>
      <span className="pagination__info" aria-live="polite">
        Showing {from}–{to} of {total} <span className="pagination__pages">(page {current} of {pages})</span>
      </span>
      <button type="button" className="btn btn--ghost" disabled={offset + limit >= total}
        onClick={() => onChange(offset + limit)}>Next →</button>
    </nav>
  );
}
