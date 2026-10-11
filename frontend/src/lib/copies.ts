import type { BorrowRequest, Copy } from '../api/types';

export type CopyViewState = 'yours' | 'unlisted' | 'requested' | 'available' | 'unavailable';

/**
 * How one physical copy should be presented to the viewing member. The server decides availability
 * (`copy.available`, derived from loans and reservations); this only adds the viewer-specific parts.
 */
export function copyViewState(copy: Copy, meId: string | null, openRequestedCopyIds: ReadonlySet<string>): CopyViewState {
  if (meId && copy.owner.id === meId) return copy.isListed ? 'yours' : 'unlisted';
  if (!copy.isListed) return 'unlisted';
  if (openRequestedCopyIds.has(copy.id)) return 'requested';
  return copy.available ? 'available' : 'unavailable';
}

/** Copy ids for which the member already has a PENDING or APPROVED request. */
export function openRequestCopyIds(requests: readonly BorrowRequest[]): Set<string> {
  return new Set(requests.filter((r) => r.status === 'PENDING' || r.status === 'APPROVED').map((r) => r.copy.id));
}

export const CONDITION_LABEL: Record<string, string> = {
  NEW: 'New',
  LIKE_NEW: 'Like new',
  GOOD: 'Good condition',
  FAIR: 'Fair condition',
  POOR: 'Well loved',
};
