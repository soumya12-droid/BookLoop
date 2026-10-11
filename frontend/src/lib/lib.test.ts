import { describe, expect, it } from 'vitest';
import type { BorrowRequest, Copy } from '../api/types';
import { ApiError } from '../api/client';
import { COVER_THEMES, coverTheme } from './covers';
import { copyViewState, openRequestCopyIds } from './copies';
import { authorLine, dueInfo, formatDueDate, initials, plural } from './format';
import { fieldErrors, friendlyMessage } from './messages';
import { safeNext } from './redirect';

const copy = (o: Partial<Copy> = {}): Copy => ({
  id: 'c1', bookId: 'b1', bookTitle: 'T', owner: { id: 'o1', displayName: 'Owner' }, condition: 'GOOD',
  isListed: true, pickupLocation: null, notes: null, available: true, createdAt: '2026-01-01T00:00:00Z', ...o,
});

describe('copyViewState', () => {
  it('own copies are "yours" (or unlisted); others depend on listing, open request and availability', () => {
    expect(copyViewState(copy(), 'o1', new Set())).toBe('yours');
    expect(copyViewState(copy({ isListed: false }), 'o1', new Set())).toBe('unlisted');
    expect(copyViewState(copy(), 'me', new Set())).toBe('available');
    expect(copyViewState(copy({ available: false }), 'me', new Set())).toBe('unavailable');
    expect(copyViewState(copy(), 'me', new Set(['c1']))).toBe('requested');
    expect(copyViewState(copy({ isListed: false }), 'me', new Set())).toBe('unlisted');
    expect(copyViewState(copy(), null, new Set())).toBe('available');
  });
  it('only PENDING and APPROVED requests count as open', () => {
    const r = (id: string, status: BorrowRequest['status']) => ({ copy: { id }, status }) as BorrowRequest;
    const s = openRequestCopyIds([r('a', 'PENDING'), r('b', 'APPROVED'), r('c', 'REJECTED'), r('d', 'CANCELLED'), r('e', 'FULFILLED')]);
    expect([...s].sort()).toEqual(['a', 'b']);
  });
});

describe('due dates (end of day in Asia/Kolkata)', () => {
  // 2026-10-10 12:00 UTC is 17:30 IST on 10 October.
  const now = Date.parse('2026-10-10T12:00:00Z');
  // The backend stores "due 20 Oct" as 21 Oct 00:00 IST = 2026-10-20T18:30:00Z.
  const dueOn = (day: number) => `2026-10-${String(day).padStart(2, '0')}T18:30:00Z`;

  it('shows the due DAY, not the following midnight', () => {
    expect(formatDueDate(dueOn(20))).toBe('20 Oct 2026');
    expect(formatDueDate('2026-10-24T18:30:00Z')).toBe('24 Oct 2026');   // 25 Oct 00:00 IST is the end of the 24th
    expect(formatDueDate('2026-10-25T18:30:00Z')).toBe('25 Oct 2026');
  });
  it('counts calendar days and describes soon, today, overdue and returned loans', () => {
    expect(dueInfo(dueOn(20), null, false, now)).toEqual({ text: 'Due in 10 days', tone: 'ok' });
    expect(dueInfo(dueOn(12), null, false, now)).toEqual({ text: 'Due in 2 days', tone: 'soon' });
    expect(dueInfo(dueOn(10), null, false, now)).toEqual({ text: 'Due today', tone: 'soon' });
    expect(dueInfo(dueOn(7), null, true, now)).toEqual({ text: 'Overdue by 3 days', tone: 'overdue' });
    expect(dueInfo(dueOn(7), '2026-10-01T00:00:00Z', false, now).tone).toBe('returned');
  });
  it('a loan handed over today for 14 days reads "Due in 14 days"', () => {
    // handed over 11 Oct (IST), 14 days => due day 25 Oct => stored as 26 Oct 00:00 IST
    const t = Date.parse('2026-10-11T06:30:00Z'); // 12:00 IST on 11 Oct
    expect(dueInfo('2026-10-25T18:30:00Z', null, false, t)).toEqual({ text: 'Due in 14 days', tone: 'ok' });
  });
  it('trusts the server overdue flag even if the local clock disagrees', () => {
    expect(dueInfo(dueOn(20), null, true, now).tone).toBe('overdue');
  });
});

describe('small helpers', () => {
  it('formats names, authors and plurals', () => {
    expect(initials('Priya Sharma')).toBe('PS');
    expect(initials('  madonna ')).toBe('M');
    expect(authorLine([{ name: 'A' }, { name: 'B' }])).toBe('A, B');
    expect(plural(1, 'copy', 'copies')).toBe('1 copy');
    expect(plural(3, 'copy', 'copies')).toBe('3 copies');
  });
  it('cover themes are deterministic and drawn from the palette', () => {
    expect(coverTheme('Dune')).toEqual(coverTheme('  dune '));
    expect(COVER_THEMES).toContainEqual(coverTheme('Anything'));
  });
});

describe('safeNext (open-redirect guard)', () => {
  it('accepts same-site paths only', () => {
    expect(safeNext('/my/loans?tab=lent')).toBe('/my/loans?tab=lent');
    for (const bad of [null, '', 'https://evil.example', '//evil.example', '/\\evil', 'javascript:alert(1)', '/login', '/register?x=1']) {
      expect(safeNext(bad)).toBe('/');
    }
  });
});

describe('messages', () => {
  it('maps codes to friendly sentences and hides server detail on 5xx', () => {
    expect(friendlyMessage(new ApiError(409, 'DUPLICATE_OPEN_REQUEST', 'raw'))).toMatch(/already have an open request/);
    expect(friendlyMessage(new ApiError(500, 'INTERNAL_ERROR', 'boom'))).not.toMatch(/boom/);
    expect(friendlyMessage(new Error('x'))).toMatch(/Something went wrong/);
  });
  it('extracts field errors from VALIDATION_ERROR details', () => {
    const e = new ApiError(400, 'VALIDATION_ERROR', 'Invalid', { details: [{ path: 'email', message: 'bad' }, { path: 'email', message: 'dup' }] });
    expect(fieldErrors(e)).toEqual({ email: 'bad' });
    expect(fieldErrors(new ApiError(409, 'X', 'y'))).toEqual({});
  });
});
