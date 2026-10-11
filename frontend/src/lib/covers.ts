// The backend has no cover-image field, so every cover is a designed placeholder. The palette is
// chosen deterministically from the title so a book always looks the same.
export interface CoverTheme { bg: string; fg: string; accent: string }

export const COVER_THEMES: CoverTheme[] = [
  { bg: '#234B3A', fg: '#F7F3E8', accent: '#D9C8AD' },
  { bg: '#C87550', fg: '#FFF8EC', accent: '#F3D9BF' },
  { bg: '#1F3A4D', fg: '#F2EBDD', accent: '#E0B879' },
  { bg: '#D9C8AD', fg: '#2B2118', accent: '#234B3A' },
  { bg: '#6B3E3A', fg: '#F7EDE0', accent: '#E8C9A0' },
  { bg: '#3C4A2F', fg: '#F4EFD9', accent: '#C9B57E' },
  { bg: '#E7DCC3', fg: '#3A2A1E', accent: '#C87550' },
  { bg: '#2E2A3A', fg: '#F2ECE0', accent: '#C9A86A' },
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function coverTheme(title: string): CoverTheme {
  return COVER_THEMES[hash(title.trim().toLowerCase()) % COVER_THEMES.length]!;
}
