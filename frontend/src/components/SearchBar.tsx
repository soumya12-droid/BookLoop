import { useState, type FormEvent } from 'react';
import { SearchIcon } from './Icons';

interface Props {
  value?: string;
  onSubmit: (q: string) => void;
  placeholder?: string;
  label?: string;
  size?: 'default' | 'large';
  buttonLabel?: string;
}

export function SearchBar({
  value = '', onSubmit, placeholder = 'Search by title, author or genre…',
  label = 'Search books', size = 'default', buttonLabel,
}: Props) {
  const [q, setQ] = useState(value);
  // Keep the field in step with the URL-driven `value` (back/forward, "clear filters").
  const [seen, setSeen] = useState(value);
  if (value !== seen) { setSeen(value); setQ(value); }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(q.trim());
  };
  return (
    <form className={`searchbar searchbar--${size}`} role="search" onSubmit={submit}>
      <label className="sr-only" htmlFor={`search-${size}`}>{label}</label>
      <SearchIcon className="searchbar__icon" />
      <input
        id={`search-${size}`} type="search" value={q} maxLength={100} autoComplete="off"
        placeholder={placeholder} onChange={(e) => setQ(e.target.value)}
      />
      {buttonLabel && <button type="submit" className="btn btn--primary searchbar__btn">{buttonLabel}</button>}
    </form>
  );
}
