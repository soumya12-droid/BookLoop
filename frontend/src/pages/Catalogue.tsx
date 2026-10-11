import { useSearchParams } from 'react-router-dom';
import { listBooks, listGenres } from '../api/endpoints';
import { BookCard } from '../components/BookCard';
import { SelectField } from '../components/Forms';
import { Pagination } from '../components/Pagination';
import { SearchBar } from '../components/SearchBar';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const PAGE_SIZE = 12;

export default function Catalogue() {
  useDocumentTitle('Books');
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const genreId = params.get('genreId') ?? '';
  const availableOnly = params.get('available') === '1';
  const offset = Math.max(0, Number(params.get('offset') ?? 0) || 0);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k); else next.set(k, v);
    }
    if (!('offset' in patch)) next.delete('offset');
    setParams(next);
  };

  const genres = useAsync((s) => listGenres(s), []);
  const books = useAsync(
    (s) => listBooks({ q: q || undefined, genreId: genreId || undefined, availableOnly, limit: PAGE_SIZE, offset }, s),
    [q, genreId, availableOnly, offset],
  );

  const genreName = genres.data?.find((g) => g.id === genreId)?.name;
  const hasFilters = !!(q || genreId || availableOnly);

  return (
    <div className="container page">
      <header className="page__head">
        <h1>{genreName ?? (q ? `Results for “${q}”` : 'All books')}</h1>
        <p className="muted">
          {books.data ? `${books.data.page.total} ${books.data.page.total === 1 ? 'title' : 'titles'}` : 'Searching the shelves…'}
        </p>
      </header>

      <div className="filters">
        <SearchBar value={q} onSubmit={(v) => update({ q: v })} placeholder="Title, author or genre" />
        <SelectField label="Genre" value={genreId} onChange={(e) => update({ genreId: e.target.value })}>
          <option value="">All genres</option>
          {genres.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </SelectField>
        <label className="check">
          <input type="checkbox" checked={availableOnly} onChange={(e) => update({ available: e.target.checked ? '1' : null })} />
          <span>Only books with an available copy</span>
        </label>
        {hasFilters && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setParams(new URLSearchParams())}>Clear filters</button>
        )}
      </div>

      {books.loading && !books.data ? <LoadingState label="Finding books…" />
        : books.error ? <ErrorState error={books.error} onRetry={books.reload} />
        : books.data && books.data.items.length > 0 ? (
          <>
            <div className={`book-grid${books.loading ? ' is-refreshing' : ''}`}>
              {books.data.items.map((b) => <BookCard key={b.id} book={b} />)}
            </div>
            <Pagination page={books.data.page} onChange={(o) => update({ offset: String(o) })} />
          </>
        ) : (
          <EmptyState title="No books match your search"
            action={hasFilters ? <button type="button" className="btn btn--primary" onClick={() => setParams(new URLSearchParams())}>Show all books</button> : undefined}>
            Try a different title, author or genre, or share the book yourself.
          </EmptyState>
        )}
    </div>
  );
}
