import { StarIcon } from './Icons';

/** Read-only rating display. `value` is 0–5; the numeric value is always available as text. */
export function Stars({ value, count, compact = false }: { value: number; count?: number; compact?: boolean }) {
  const rounded = Math.round(value);
  return (
    <span className={`stars${compact ? ' stars--compact' : ''}`}>
      <span className="stars__icons" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((i) => <StarIcon key={i} filled={i <= rounded} width={compact ? 14 : 18} height={compact ? 14 : 18} />)}
      </span>
      <span className="stars__text">
        <span className="sr-only">Rated </span>{value.toFixed(1)}<span className="sr-only"> out of 5</span>
        {count !== undefined && <span className="stars__count"> ({count})</span>}
      </span>
    </span>
  );
}
