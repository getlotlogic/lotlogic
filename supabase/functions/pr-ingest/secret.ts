/**
 * Pure helper: extracts the trailing path segment from a request URL and compares it
 * against the expected secret. Exported so tests can exercise it without a live server.
 *
 * Returns true only when `expected` is non-empty AND equals the trailing segment.
 */
export function extractAndCheckSecret(url: URL, expected: string): boolean {
  if (!expected) return false;
  const trailing = url.pathname.replace(/^\/functions\/v1\/pr-ingest\/?/, "");
  return trailing === expected;
}
