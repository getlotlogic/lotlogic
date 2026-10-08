/**
 * Production-safety guard for the portal suite. The fixture's `sql()` clears
 * `auth_throttle`, archives properties and rewrites delivery rows, and the
 * browser half posts real signups — so both the API it drives and the
 * database it writes must be on this machine (or the CI runner's own
 * service container on localhost). Anything else is refused.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function loopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return LOOPBACK.has(h) || /^127(?:\.\d{1,3}){3}$/.test(h) || h.endsWith('.localhost');
}

/** True only for an http(s) or postgres URL whose every host is loopback,
 *  or a libpq URL that reaches the server over a local Unix socket. */
export function isLoopbackUrl(raw: string | undefined | null): boolean {
  if (!raw) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  const scheme = u.protocol.replace(/:$/, '');
  if (!['http', 'https', 'postgres', 'postgresql'].includes(scheme)) return false;
  const isPg = scheme.startsWith('postgres');
  // libpq lets `?host=` / `?hostaddr=` override the authority; check every one.
  const queryHosts = isPg
    ? [...u.searchParams.getAll('host'), ...u.searchParams.getAll('hostaddr')]
        .flatMap((v) => v.split(','))
        .filter((v) => v.length > 0)
    : [];
  // A multi-host authority (`a,b:5432`) does not parse to one hostname: refuse.
  if (u.hostname.includes(',')) return false;
  if (!u.hostname && !queryHosts.length) return isPg; // `postgresql:///db` = default local socket
  const hosts = [...(u.hostname ? [u.hostname] : []), ...queryHosts];
  return hosts.every((h) => (isPg && h.startsWith('/')) || loopbackHost(h));
}
