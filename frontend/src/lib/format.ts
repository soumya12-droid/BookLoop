const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/**
 * The backend sets every due date to the END of a day in Asia/Kolkata (docs/API.md), i.e. midnight at
 * the start of the following day. All "due" wording therefore works on that campus calendar day.
 * IST has a fixed +05:30 offset (no daylight saving), so plain arithmetic is exact.
 */
export const CAMPUS_TZ = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * MINUTE;

const istDayNumber = (ms: number) => Math.floor((ms + IST_OFFSET_MS) / DAY);

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The calendar day a loan is due on (the day *before* the end-of-day timestamp), e.g. "25 Oct 2026". */
export function formatDueDate(dueAtIso: string): string {
  const t = Date.parse(dueAtIso);
  if (Number.isNaN(t)) return '';
  return new Date(t - MINUTE).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: CAMPUS_TZ,
  });
}

export type DueTone = 'ok' | 'soon' | 'overdue' | 'returned';

/** Human wording for a due date. "Soon" is within 3 days; overdue also honours the server's own flag. */
export function dueInfo(
  dueAt: string, returnedAt: string | null, isOverdue: boolean, now: number = Date.now(),
): { text: string; tone: DueTone } {
  if (returnedAt) return { text: `Returned ${formatDate(returnedAt)}`, tone: 'returned' };
  const dueDay = istDayNumber(Date.parse(dueAt) - MINUTE);
  const diff = dueDay - istDayNumber(now);                // calendar days until the due day
  if (isOverdue || diff < 0) {
    const days = Math.max(1, -diff);
    return { text: `Overdue by ${days} ${days === 1 ? 'day' : 'days'}`, tone: 'overdue' };
  }
  if (diff === 0) return { text: 'Due today', tone: 'soon' };
  return { text: `Due in ${diff} ${diff === 1 ? 'day' : 'days'}`, tone: diff <= 3 ? 'soon' : 'ok' };
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? parts[parts.length - 1]![0] ?? '' : '';
  return (a + b).toUpperCase();
}

export function authorLine(authors: { name: string }[]): string {
  return authors.map((a) => a.name).join(', ');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
