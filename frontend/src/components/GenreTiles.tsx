import { Link } from 'react-router-dom';
import type { NamedRef } from '../api/types';
import { coverTheme } from '../lib/covers';

/** Genre navigation tiles. Colour is derived from the name; there are no genre photographs. */
export function GenreTiles({ genres }: { genres: NamedRef[] }) {
  return (
    <ul className="genre-grid">
      {genres.map((g) => {
        const t = coverTheme(g.name);
        return (
          <li key={g.id}>
            <Link className="genre-tile" to={`/books?genreId=${g.id}`}
              style={{ background: `linear-gradient(160deg, ${t.bg}, color-mix(in srgb, ${t.bg} 70%, #000))`, color: t.fg }}>
              <span>{g.name}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
