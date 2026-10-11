import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createBook, createCopy, listBooks, listGenres } from '../api/endpoints';
import { CONDITIONS } from '../api/endpoints';
import type { Book, CopyCondition } from '../api/types';
import { Cover } from '../components/Cover';
import { SelectField, TextArea, TextField } from '../components/Forms';
import { SearchBar } from '../components/SearchBar';
import { ErrorState, LoadingState, Notice } from '../components/States';
import { useAsync } from '../hooks/useAsync';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { authorLine } from '../lib/format';
import { fieldErrors, friendlyMessage } from '../lib/messages';

type Step = 'find' | 'new-title' | 'copy';

/**
 * List-a-book flow. Search first so an existing catalogue title is reused (the API only guarantees
 * uniqueness for ISBNs); only create a new title when nothing fits; then add YOUR physical copy.
 */
export default function ListBook() {
  useDocumentTitle('List a book');
  const nav = useNavigate();
  const [step, setStep] = useState<Step>('find');
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<Pick<Book, 'id' | 'title'> | null>(null);

  const results = useAsync(
    (s) => (query.length >= 2 ? listBooks({ q: query, limit: 8 }, s) : Promise.resolve(null)),
    [query],
  );
  const genres = useAsync((s) => listGenres(s), []);

  // ---- new title form ----
  const [tf, setTf] = useState({ title: '', authors: '', isbn: '', publisher: '', publicationYear: '', edition: '', description: '' });
  const [genreIds, setGenreIds] = useState<string[]>([]);
  const [fields, setFields] = useState<Record<string, string>>({});
  // ---- copy form ----
  const [cf, setCf] = useState<{ condition: CopyCondition; pickupLocation: string; notes: string }>({ condition: 'GOOD', pickupLocation: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitTitle = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const local: Record<string, string> = {};
    if (!tf.title.trim()) local.title = 'A title is required.';
    const year = tf.publicationYear.trim() ? Number(tf.publicationYear) : null;
    if (year !== null && (!Number.isInteger(year) || year < 1400 || year > 2100)) local.publicationYear = 'Enter a year between 1400 and 2100.';
    setFields(local);
    if (Object.keys(local).length) return;

    setBusy(true); setError(null);
    try {
      const book = await createBook({
        title: tf.title.trim(),
        authors: tf.authors.split(',').map((a) => a.trim()).filter(Boolean),
        isbn: tf.isbn.trim() || null,
        publisher: tf.publisher.trim() || null,
        edition: tf.edition.trim() || null,
        publicationYear: year,
        description: tf.description.trim() || null,
        genreIds,
      });
      setChosen({ id: book.id, title: book.title });
      setStep('copy');
    } catch (err) {
      setFields(fieldErrors(err));
      setError(friendlyMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCopy = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !chosen) return;
    setBusy(true); setError(null);
    try {
      await createCopy(chosen.id, {
        condition: cf.condition,
        pickupLocation: cf.pickupLocation.trim() || null,
        notes: cf.notes.trim() || null,
      });
      nav('/my/listings', { replace: true });
    } catch (err) {
      setFields(fieldErrors(err));
      setError(friendlyMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="container page page--narrow">
      <header className="page__head">
        <h1>List a book</h1>
        <p className="muted">Share a book you own. Members can ask to borrow it, and you decide each request.</p>
      </header>

      <ol className="stepper" aria-label="Progress">
        <li className={step === 'find' ? 'is-current' : 'is-done'}>Find the title</li>
        <li className={step === 'new-title' ? 'is-current' : step === 'copy' ? 'is-done' : ''}>Title details</li>
        <li className={step === 'copy' ? 'is-current' : ''}>Your copy</li>
      </ol>

      {step === 'find' && (
        <section className="panel">
          <h2>Is your book already in BookLoop?</h2>
          <p className="muted">Search by title, author or ISBN. Reusing an existing title keeps the catalogue tidy.</p>
          <SearchBar value={query} onSubmit={setQuery} buttonLabel="Search" placeholder="Title, author or ISBN" size="large" />
          {query.length >= 2 && (
            results.loading && !results.data ? <LoadingState label="Searching…" />
              : results.error ? <ErrorState error={results.error} onRetry={results.reload} />
              : results.data && results.data.items.length > 0 ? (
                <ul className="rows pick-list">
                  {results.data.items.map((b) => (
                    <li key={b.id} className="row">
                      <Cover title={b.title} size="sm" />
                      <div className="row__main">
                        <strong className="row__title">{b.title}</strong>
                        <p className="muted">{authorLine(b.authors) || 'Unknown author'}{b.publicationYear ? ` · ${b.publicationYear}` : ''}</p>
                      </div>
                      <button type="button" className="btn btn--primary btn--sm"
                        onClick={() => { setChosen({ id: b.id, title: b.title }); setError(null); setStep('copy'); }}>
                        Add my copy
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <Notice tone="info">No match for “{query}”. You can add it as a new title.</Notice>
          )}
          <div className="form__actions">
            <button type="button" className="btn btn--outline"
              onClick={() => { setTf((t) => ({ ...t, title: query })); setFields({}); setError(null); setStep('new-title'); }}>
              My book isn’t listed — add a new title
            </button>
          </div>
        </section>
      )}

      {step === 'new-title' && (
        <form className="panel form" onSubmit={submitTitle} noValidate>
          <h2>New title</h2>
          <TextField label="Title" required maxLength={300} value={tf.title} error={fields.title}
            onChange={(e) => setTf({ ...tf, title: e.target.value })} />
          <TextField label="Author(s)" maxLength={500} value={tf.authors} error={fields.authors}
            hint="Separate several authors with commas." onChange={(e) => setTf({ ...tf, authors: e.target.value })} />
          <fieldset className="fieldset">
            <legend>Genres</legend>
            {genres.data ? (
              <div className="check-grid">
                {genres.data.map((g) => (
                  <label key={g.id} className="check">
                    <input type="checkbox" checked={genreIds.includes(g.id)}
                      onChange={(e) => setGenreIds(e.target.checked ? [...genreIds, g.id].slice(0, 10) : genreIds.filter((x) => x !== g.id))} />
                    <span>{g.name}</span>
                  </label>
                ))}
              </div>
            ) : genres.error ? <p className="field__error">Genres could not be loaded; you can still continue.</p> : <p className="muted">Loading genres…</p>}
          </fieldset>
          <div className="grid-2">
            <TextField label="ISBN-13 (optional)" inputMode="numeric" maxLength={20} value={tf.isbn} error={fields.isbn}
              hint="Digits only or with hyphens." onChange={(e) => setTf({ ...tf, isbn: e.target.value })} />
            <TextField label="Publication year (optional)" inputMode="numeric" maxLength={4} value={tf.publicationYear}
              error={fields.publicationYear} onChange={(e) => setTf({ ...tf, publicationYear: e.target.value })} />
            <TextField label="Publisher (optional)" maxLength={120} value={tf.publisher} error={fields.publisher}
              onChange={(e) => setTf({ ...tf, publisher: e.target.value })} />
            <TextField label="Edition (optional)" maxLength={60} value={tf.edition} error={fields.edition}
              onChange={(e) => setTf({ ...tf, edition: e.target.value })} />
          </div>
          <TextArea label="Description (optional)" rows={4} maxLength={4000} value={tf.description} error={fields.description}
            onChange={(e) => setTf({ ...tf, description: e.target.value })} />
          {error && <Notice tone="error">{error}</Notice>}
          <div className="form__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setStep('find')} disabled={busy}>Back</button>
            <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Continue'}</button>
          </div>
        </form>
      )}

      {step === 'copy' && chosen && (
        <form className="panel form" onSubmit={submitCopy} noValidate>
          <h2>Your copy of <em>{chosen.title}</em></h2>
          <p className="muted">
            This adds one physical copy owned by you. The title is shared with every member who lists a copy.{' '}
            <Link to={`/books/${chosen.id}`}>View title</Link>
          </p>
          <SelectField label="Condition" value={cf.condition} error={fields.condition}
            onChange={(e) => setCf({ ...cf, condition: e.target.value as CopyCondition })}>
            {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </SelectField>
          <TextField label="Pickup place (optional)" maxLength={200} value={cf.pickupLocation} error={fields.pickupLocation}
            hint="Leave blank to use the default pickup place from your profile."
            onChange={(e) => setCf({ ...cf, pickupLocation: e.target.value })} />
          <TextArea label="Note for borrowers (optional)" rows={3} maxLength={500} value={cf.notes} error={fields.notes}
            onChange={(e) => setCf({ ...cf, notes: e.target.value })} />
          {error && <Notice tone="error">{error}</Notice>}
          <div className="form__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setStep('find')} disabled={busy}>Back</button>
            <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Listing…' : 'List this copy'}</button>
          </div>
        </form>
      )}
    </div>
  );
}
