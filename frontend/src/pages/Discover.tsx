import { Link, useNavigate } from 'react-router-dom';
import { listBooks, listGenres } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { BookCard } from '../components/BookCard';
import { ArrowRight, LeafIcon, PlusIcon, StackIcon, UsersIcon } from '../components/Icons';
import { SearchBar } from '../components/SearchBar';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { GenreTiles } from '../components/GenreTiles';

/** Decorative illustration (no data): a small stack of books and a sprig, drawn in the brand palette. */
function HeroArt() {
  return (
    <svg className="hero__art" viewBox="0 0 440 320" role="img" aria-label="Illustration of a stack of books beside a leafy sprig">
      <path d="M330 300c-10-60 6-120 52-168" fill="none" stroke="#234B3A" strokeWidth="2" opacity=".55" />
      <path d="M382 132c18-4 34 4 42 20-18 6-34 0-42-20Zm-12 40c-18-6-38 0-48 16 18 10 38 6 48-16Zm4 52c18-2 34 6 40 22-18 4-34-2-40-22Zm-18 36c-16-8-36-4-46 10 16 10 36 8 46-10Z" fill="#234B3A" opacity=".5" />
      <g strokeLinejoin="round">
        <rect x="70" y="252" width="236" height="40" rx="6" fill="#234B3A" />
        <rect x="70" y="252" width="236" height="10" rx="4" fill="#1A3A2D" />
        <rect x="92" y="210" width="196" height="42" rx="6" fill="#C87550" />
        <rect x="92" y="210" width="196" height="10" rx="4" fill="#A95D3C" />
        <rect x="60" y="170" width="224" height="40" rx="6" fill="#D9C8AD" />
        <rect x="60" y="170" width="224" height="10" rx="4" fill="#C2AE8E" />
        <rect x="104" y="130" width="168" height="40" rx="6" fill="#2E5D49" />
        <rect x="104" y="130" width="168" height="10" rx="4" fill="#234B3A" />
      </g>
      <g fill="#F7F3E8" opacity=".9">
        <rect x="96" y="268" width="90" height="4" rx="2" />
        <rect x="118" y="226" width="70" height="4" rx="2" />
        <rect x="86" y="186" width="80" height="4" rx="2" />
        <rect x="130" y="146" width="60" height="4" rx="2" />
      </g>
      <path d="M120 112c10-30 40-34 52-8l-14 14c-12-4-24 2-38-6Z" fill="#E7DCC3" stroke="#D9C8AD" />
    </svg>
  );
}

export default function Discover() {
  useDocumentTitle('');
  const { status } = useAuth();
  const nav = useNavigate();
  const signedIn = status === 'authenticated';

  // The catalogue is public, so these load for everyone and do not depend on being signed in.
  const available = useAsync((s) => listBooks({ availableOnly: true, limit: 6 }, s), []);
  const latest = useAsync((s) => listBooks({ limit: 12 }, s), []);
  const genres = useAsync((s) => listGenres(s), []);

  const goSearch = (q: string) => nav(q ? `/books?q=${encodeURIComponent(q)}` : '/books');

  return (
    <>
      <section className="hero">
        <div className="container hero__inner">
          <div className="hero__copy">
            <h1>Good books deserve more than one reader.</h1>
            <p className="hero__lede">
              Borrow, lend and share the books on your own shelves. List what you have already read,
              find your next read nearby, and keep great stories in circulation in your community.
            </p>
            <SearchBar size="large" onSubmit={goSearch} buttonLabel="Search" label="Search for a title, author or genre" />
            <div className="hero__actions">
              <Link to="/books" className="btn btn--primary">Explore books <ArrowRight width={18} height={18} /></Link>
              <Link to="/list" className="btn btn--outline"><PlusIcon width={18} height={18} /> Share a book</Link>
            </div>
          </div>
          <div className="hero__visual"><HeroArt /></div>
        </div>
      </section>

      <section className="container section" aria-labelledby="avail-h">
        <div className="section__head">
          <div>
            <h2 id="avail-h" className="section__title">Recently Added</h2>
            <p className="muted">Titles with at least one copy you can request today.</p>
          </div>
          <Link className="textlink" to="/books?available=1">View all <ArrowRight width={16} height={16} /></Link>
        </div>
        {available.loading && !available.data ? <LoadingState label="Finding available books…" />
          : available.error ? <ErrorState error={available.error} onRetry={available.reload} />
          : available.data && available.data.items.length > 0 ? (
            <div className="book-grid book-grid--row">
              {available.data.items.map((b) => <BookCard key={b.id} book={b} />)}
            </div>
          ) : (
            <EmptyState title="Nothing is available right now"
              action={<Link className="btn btn--primary" to="/list">Be the first to share a book</Link>}>
              When members list copies, they appear here.
            </EmptyState>
          )}
      </section>

      <section className="container section" aria-labelledby="genre-h">
        <div className="section__head">
          <h2 id="genre-h" className="section__title">Browse by genre</h2>
          <Link className="textlink" to="/genres">All genres <ArrowRight width={16} height={16} /></Link>
        </div>
        {genres.error ? <ErrorState error={genres.error} onRetry={genres.reload} />
          : genres.data ? <GenreTiles genres={genres.data} /> : <LoadingState label="Loading genres…" />}
      </section>

      {!signedIn && (
        <section className="container section">
          <h2 className="section__title">How BookLoop works</h2>
          <ol className="steps">
            <li><span className="steps__n">1</span><h3>Find a book</h3><p>Search the shelves of members in your community and see which copies are free to borrow.</p></li>
            <li><span className="steps__n">2</span><h3>Ask to borrow</h3><p>Send a request for a specific copy. Its owner approves it and you arrange a hand-over.</p></li>
            <li><span className="steps__n">3</span><h3>Read and return</h3><p>Enjoy the book, give it back by the due date, and leave a review for the next reader.</p></li>
          </ol>
          <div className="cta-band">
            <div>
              <h2>Join your community’s bookshelf</h2>
              <p>Create a free account to request copies and share your own books.</p>
            </div>
            <div className="cta-band__actions">
              <Link to="/register" className="btn btn--primary">Join BookLoop</Link>
              <Link to="/login" className="btn btn--ghost">Sign in</Link>
            </div>
          </div>
        </section>
      )}

      <section className="band" aria-labelledby="community-h">
        <div className="container band__inner">
          <div>
            <h2 id="community-h">A community that keeps books moving.</h2>
            <p>
              Every book that is lent is one fewer bought, stored and forgotten. Sharing keeps good
              stories in use, saves members money and builds a reading culture close to home.
            </p>
          </div>
          <ul className="band__facts">
            <li><StackIcon width={30} height={30} /><span>Many copies, many owners</span><small>Each physical copy is tracked on its own.</small></li>
            <li><UsersIcon width={30} height={30} /><span>Arranged between members</span><small>Owners approve every request.</small></li>
            <li><LeafIcon width={30} height={30} /><span>Fewer books bought</span><small>Borrow first, buy only what you will keep.</small></li>
          </ul>
        </div>
      </section>

      {signedIn && (
        <section className="container section" aria-labelledby="cat-h">
          <div className="section__head">
            <div>
              <h2 id="cat-h" className="section__title">From the catalogue</h2>
              {latest.data && (
                <p className="muted">{latest.data.page.total} {latest.data.page.total === 1 ? 'title' : 'titles'} in the catalogue.</p>
              )}
            </div>
            <Link className="textlink" to="/books">Browse all <ArrowRight width={16} height={16} /></Link>
          </div>
          {latest.loading && !latest.data ? <LoadingState />
            : latest.error ? <ErrorState error={latest.error} onRetry={latest.reload} />
            : latest.data && latest.data.items.length > 0 ? (
              <div className="book-grid">{latest.data.items.map((b) => <BookCard key={b.id} book={b} />)}</div>
            ) : <EmptyState title="The catalogue is empty">Add the first book with “Share a book”.</EmptyState>}
        </section>
      )}
    </>
  );
}
