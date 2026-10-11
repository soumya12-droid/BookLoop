import { listGenres } from '../api/endpoints';
import { GenreTiles } from '../components/GenreTiles';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export default function Genres() {
  useDocumentTitle('Genres');
  const g = useAsync((s) => listGenres(s), []);
  return (
    <div className="container page">
      <header className="page__head">
        <h1>Genres</h1>
        <p className="muted">Pick a genre to see the books members have shared.</p>
      </header>
      {g.loading && !g.data ? <LoadingState label="Loading genres…" />
        : g.error ? <ErrorState error={g.error} onRetry={g.reload} />
        : g.data && g.data.length > 0 ? <GenreTiles genres={g.data} />
        : <EmptyState title="No genres yet" />}
    </div>
  );
}
