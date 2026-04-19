// URL layout: /functions/v1/camera-snapshot/<camera_api_key>/<secret>
// The Supabase runtime delivers it as /camera-snapshot/<api_key>/<secret>.

export function parsePath(url: URL): { apiKey: string | null; secret: string | null } {
  const stripped = url.pathname
    .replace(/^\/functions\/v1\/camera-snapshot\/?/, "")
    .replace(/^\/camera-snapshot\/?/, "");
  const parts = stripped.split("/").filter(Boolean);
  return {
    apiKey: parts[0] ?? null,
    secret: parts[1] ?? null,
  };
}
