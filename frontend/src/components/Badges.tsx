import type { ReactNode } from 'react';
import type { RequestStatus } from '../api/types';
import type { DueTone } from '../lib/format';

type Tone = 'available' | 'unavailable' | 'requested' | 'yours' | 'pending' | 'approved' | 'rejected' | 'muted' | 'overdue' | 'soon' | 'ok';

export function Badge({ tone, children, dot = true }: { tone: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`badge badge--${tone}`}>
      {dot && <span className="badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Availability of one physical copy, for the viewing member. */
export function AvailabilityBadge({ state }: { state: 'available' | 'unavailable' | 'requested' | 'yours' | 'unlisted' }) {
  switch (state) {
    case 'available': return <Badge tone="available">Available</Badge>;
    case 'requested': return <Badge tone="requested">Requested by you</Badge>;
    case 'yours': return <Badge tone="yours">Your copy</Badge>;
    case 'unlisted': return <Badge tone="muted">Not listed</Badge>;
    default: return <Badge tone="unavailable">Not available now</Badge>;
  }
}

const REQUEST_LABEL: Record<RequestStatus, [Tone, string]> = {
  PENDING: ['pending', 'Pending'],
  APPROVED: ['approved', 'Approved'],
  REJECTED: ['rejected', 'Declined'],
  CANCELLED: ['muted', 'Cancelled'],
  FULFILLED: ['ok', 'Handed over'],
};

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  const [tone, label] = REQUEST_LABEL[status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function DueBadge({ tone, text }: { tone: DueTone; text: string }) {
  const map: Record<DueTone, Tone> = { ok: 'ok', soon: 'soon', overdue: 'overdue', returned: 'muted' };
  return <Badge tone={map[tone]}>{text}</Badge>;
}
