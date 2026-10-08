/**
 * Portal suite global setup (Task 30). Only when `PORTAL_E2E=1`: builds this
 * branch's frontend once and serves it, with `vercel.json`'s rewrites, on a
 * FIXED origin — `http://127.0.0.1:${PORTAL_FRONTEND_PORT:-4173}` — because
 * the local backend's CORS allow-list has to name it exactly
 * (`CORS_ALLOWED_ORIGINS=http://127.0.0.1:4173`, tests/README.md). Every
 * spec in the run (portal, axe, access-control) then uses that origin as
 * `BASE_URL` (playwright.config.ts). With `PORTAL_E2E` unset this is a no-op
 * and nothing about the normal suite changes.
 */
import path from 'node:path';
import { buildAndServeFrontend } from './buildAndServeFrontend';

export default async function portalGlobalSetup() {
  if (process.env.PORTAL_E2E !== '1') return undefined;
  const port = Number(process.env.PORTAL_FRONTEND_PORT ?? 4173);
  const server = await buildAndServeFrontend(path.resolve(__dirname, '../../frontend'), { port });
  process.env.PORTAL_FRONTEND_ORIGIN = server.origin;
  return async () => { await server.close(); };
}
