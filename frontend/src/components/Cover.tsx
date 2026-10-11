import { useState } from 'react';
import { coverTheme } from '../lib/covers';

interface CoverProps {
  title: string;
  authors?: string;
  /** Reserved: the backend has no cover-image field yet. If one is added it is used, with this fallback. */
  src?: string | null;
  size?: 'sm' | 'md' | 'lg';
}

/** A book cover. Always renders a designed typographic cover, so layouts never depend on images. */
export function Cover({ title, authors, src, size = 'md' }: CoverProps) {
  const [broken, setBroken] = useState(false);
  const theme = coverTheme(title);

  if (src && !broken) {
    return (
      <div className={`cover cover--${size}`}>
        <img src={src} alt={`Cover of ${title}`} loading="lazy" onError={() => setBroken(true)} />
      </div>
    );
  }
  return (
    <div
      className={`cover cover--${size} cover--generated`}
      style={{ background: theme.bg, color: theme.fg, ['--cover-accent' as string]: theme.accent }}
      role="img"
      aria-label={`Cover of ${title}${authors ? ` by ${authors}` : ''}`}
    >
      <span className="cover__rule" aria-hidden="true" />
      <span className="cover__title">{title}</span>
      {authors && <span className="cover__author">{authors}</span>}
    </div>
  );
}
