import { Link } from 'react-router-dom';
import type { Book } from '../api/types';
import { authorLine, plural } from '../lib/format';
import { Badge } from './Badges';
import { Cover } from './Cover';
import { Stars } from './Stars';

export function BookCard({ book }: { book: Book }) {
  const authors = authorLine(book.authors);
  const available = book.availableCopies > 0;
  return (
    <article className="book-card">
      <Link to={`/books/${book.id}`} className="book-card__link" aria-label={`${book.title}${authors ? `, by ${authors}` : ''}`}>
        <Cover title={book.title} authors={authors} size="md" />
        <h3 className="book-card__title">{book.title}</h3>
        {authors && <p className="book-card__author">{authors}</p>}
      </Link>
      <div className="book-card__meta">
        {available
          ? <Badge tone="available">Available · {plural(book.availableCopies, 'copy', 'copies')}</Badge>
          : <Badge tone="unavailable">No copies available</Badge>}
        {book.averageRating !== null && <Stars value={book.averageRating} count={book.reviewCount} compact />}
      </div>
    </article>
  );
}
