// URL layouts accepted:
//   /functions/v1/camera-snapshot/<secret>                      (identity from body)
//   /functions/v1/camera-snapshot/<api_key>/<secret>             (identity from path)
// The Supabase runtime delivers the path without the `/functions/v1` prefix,
// so we strip both forms.

export function parsePath(url: URL): { apiKey: string | null; secret: string | null } {
  const stripped = url.pathname
    .replace(/^\/functions\/v1\/camera-snapshot\/?/, "")
    .replace(/^\/camera-snapshot\/?/, "");
  const parts = stripped.split("/").filter(Boolean);
  if (parts.length === 1) {
    return { apiKey: null, secret: parts[0] };
  }
  if (parts.length >= 2) {
    return { apiKey: parts[0], secret: parts[1] };
  }
  return { apiKey: null, secret: null };
}
