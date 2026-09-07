/**
 * Shared "build once, serve dist/" helper for e2e specs that embed their own
 * local static server instead of pointing at BASE_URL.
 *
 * Before Task 17 (2026-09-07), `visit.html`/`resident.html`/`apt.html` (and,
 * since Task 13, `dashboard.html`) were fully self-contained: every page's
 * script ran inline, so a spec could serve `frontend/` straight from source
 * and the page would boot with no build step. That stopped being true once
 * each page's script became `<script type="module" src="/visit.js">` etc —
 * those files exist only in `frontend/dist/`, produced by `npm run build`,
 * never in the source tree. A spec that still serves raw `frontend/` gets a
 * 404 on the entry module and the page never boots (`#passForm` etc. never
 * appear, tests time out waiting for it).
 *
 * Each call gets its OWN private output directory (via `build.mjs`'s
 * `LOTLOGIC_BUILD_OUT` env var), not the shared `frontend/dist/`. Playwright
 * can run multiple spec files' `beforeAll`s concurrently across workers
 * (`fullyParallel: true`), and each of those would otherwise call `npm run
 * build` against the SAME `frontend/dist/` at the same time — one worker's
 * `rm(DIST) + rebuild` can delete files a sibling worker's already-running
 * static server is actively serving mid-test, independent of whether the
 * builds themselves are serialized. Giving each caller a unique directory
 * (removed again in `close()`) sidesteps the shared-mutable-directory
 * problem entirely instead of trying to lock around it.
 */
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface BuiltFrontendServer {
  origin: string;
  close: () => Promise<void>;
}

export async function buildAndServeFrontend(frontendDir: string): Promise<BuiltFrontendServer> {
  const outName = `.test-dist-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const outDir = path.join(frontendDir, outName);

  execFileSync('npm', ['run', 'build'], {
    cwd: frontendDir,
    stdio: 'inherit',
    env: { ...process.env, LOTLOGIC_BUILD_OUT: outName },
  });

  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = path.join(outDir, pathname.replace(/^\/+/, ''));
    if (!file.startsWith(outDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
      : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
      : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(file).pipe(res);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((resolve) => server.close(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
    resolve();
  }));
  return { origin, close };
}
