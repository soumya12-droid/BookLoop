/** Only same-site paths are accepted as a post-login destination (prevents open redirects). */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw.startsWith('/login') || raw.startsWith('/register')) return '/';
  return raw;
}
