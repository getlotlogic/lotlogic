/**
 * Pure helper: extracts the trailing path segment from a request URL and compares it
 * against the expected secret. Exported so tests can exercise it without a live server.
 *
 * Returns true only when `expected` is non-empty AND equals the trailing segment.
 */
export function extractAndCheckSecret(url: URL, expected: string): boolean {
  if (!expected) return false;
  // The Supabase edge runtime delivers req.url with pathname `/pr-ingest/<secret>`,
  // but the hosted URL and our tests use `/functions/v1/pr-ingest/<secret>`. Accept both.
  const trailing = url.pathname
    .replace(/^\/functions\/v1\/pr-ingest\/?/, "")
    .replace(/^\/pr-ingest\/?/, "");
  return trailing === expected;
}
