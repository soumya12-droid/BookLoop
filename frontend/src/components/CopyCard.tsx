import { Link, useLocation } from 'react-router-dom';
import type { Copy } from '../api/types';
import { CONDITION_LABEL, type CopyViewState } from '../lib/copies';
import { AvailabilityBadge } from './Badges';

interface Props {
  copy: Copy;
  state: CopyViewState;
  signedIn: boolean;
  busy: boolean;
  onRequest: (copy: Copy) => void;
}

/** One physical copy: its own owner, condition, pickup details and availability. */
export function CopyCard({ copy, state, signedIn, busy, onRequest }: Props) {
  const loc = useLocation();
  return (
    <li className="copy-card">
      <div className="copy-card__top">
        <strong className="copy-card__condition">{CONDITION_LABEL[copy.condition] ?? copy.condition}</strong>
        <AvailabilityBadge state={state} />
      </div>
      <p className="copy-card__owner">Shared by {copy.owner.displayName}</p>
      {copy.pickupLocation && <p className="copy-card__detail"><span>Pickup</span> {copy.pickupLocation}</p>}
      {copy.notes && <p className="copy-card__detail"><span>Note</span> {copy.notes}</p>}

      {state === 'available' && (signedIn ? (
        <button type="button" className="btn btn--primary btn--block" disabled={busy}
          onClick={() => onRequest(copy)}>{busy ? 'Sending request…' : 'Request to borrow'}</button>
      ) : (
        // Anonymous visitors sign in and are brought straight back to this page.
        <Link className="btn btn--primary btn--block"
          to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`}>Sign in to borrow</Link>
      ))}
      {!signedIn && <p className="hint">Sign in to see pickup details.</p>}
      {state === 'requested' && (
        <Link className="btn btn--ghost btn--block" to="/my/requests">View your request</Link>
      )}
      {(state === 'yours' || state === 'unlisted') && (
        <Link className="btn btn--ghost btn--block" to="/my/listings">Manage listing</Link>
      )}
    </li>
  );
}
