// The LotLogic frontend build.
//   1. bundle the dashboard's JSX into dist/dashboard.js, and the three
//      registration pages' entry files into dist/{visit,resident,apt}.js
//   2. stage every static file into dist/ (dist IS the Vercel output directory)
// Deliberately one file with no config language: the whole build should be
// readable in one sitting by whoever is on call.
import { build } from 'esbuild';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// LOTLOGIC_BUILD_OUT lets a caller point the build at a private output
// directory instead of the shared `dist/` — used by
// tests/fixtures/buildAndServeFrontend.ts so concurrent Playwright workers
// each get their own isolated build instead of racing to rm+rebuild the
// same `frontend/dist/` (and, worse, deleting it out from under a sibling
// worker's already-running static server). Unset, this is exactly `dist`,
// same as before this existed — the real `npm run build` / Vercel build is
// unaffected.
const DIST_NAME = process.env.LOTLOGIC_BUILD_OUT || 'dist';
const DIST = path.join(ROOT, DIST_NAME);
const DEV = process.argv.includes('--dev');

// Guard LOTLOGIC_BUILD_OUT before anything destructive runs. The build does
// `rm(DIST, { recursive: true, force: true })` below — if a caller sets
// LOTLOGIC_BUILD_OUT to '.', '..', an absolute path, or anything containing
// '/', DIST resolves outside (or to the root of) frontend/ and that rm wipes
// the source tree instead of a build output dir. Only the shared 'dist' name
// and the `.test-dist-*` names buildAndServeFrontend.ts generates are valid;
// everything else must be rejected before DIST is ever touched.
const VALID_DIST_NAME = /^(dist|\.test-dist-[A-Za-z0-9_-]+)$/;
const resolvedDist = path.resolve(ROOT, DIST_NAME);
if (
  !VALID_DIST_NAME.test(DIST_NAME) ||
  resolvedDist === ROOT ||
  !resolvedDist.startsWith(ROOT + path.sep)
) {
  console.error(
    `build: refusing to build — LOTLOGIC_BUILD_OUT=${JSON.stringify(DIST_NAME)} ` +
    `must be 'dist' or a '.test-dist-*' name inside frontend/, not an escape from it.`
  );
  process.exit(2);
}

// Files and directories that are inputs, not output. Deny-list, not
// allow-list: a new page must ship by default, never be silently dropped.
// `DIST_NAME` is always excluded too (not just the literal 'dist') so a
// custom LOTLOGIC_BUILD_OUT output directory never tries to copy itself
// into itself in step 2 below.
const NOT_OUTPUT = new Set([
  'dist', DIST_NAME, 'node_modules', 'src', 'scripts',
  'package.json', 'package-lock.json', '.npmrc', 'vercel.json',
  'Dockerfile', 'nginx.conf', 'railway.toml',
]);

// ── 1. the JS bundles ──────────────────────────────────────────────────────
// The dashboard plus the three registration pages' entry files (Task 17 /
// FAT-18 — visit.html/resident.html/apt.html each swap their old inline
// <script> for `<script type="module" src="/visit.js">` etc). One build()
// call, one shared `entryNames: '[name]'` so esbuild names each output file
// after its own entry (dashboard.jsx -> dashboard.js, visit.js -> visit.js,
// ...) instead of the single hardcoded 'dashboard' this used before there
// was more than one entry point.
await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const result = await build({
  entryPoints: [
    path.join(ROOT, 'src/dashboard.jsx'),
    path.join(ROOT, 'src/visit.js'),
    path.join(ROOT, 'src/resident.js'),
    path.join(ROOT, 'src/apt.js'),
  ],
  outdir: DIST,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  format: 'esm',
  splitting: true,
  target: ['es2020'],
  jsx: 'transform',              // React.createElement — same output shape as Babel
  minify: !DEV,
  sourcemap: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': DEV ? '"development"' : '"production"' },
  logLevel: 'info',
  metafile: true,
});
await writeFile(path.join(DIST, 'metafile.json'), JSON.stringify(result.metafile));

// ── 2. stage the static site ───────────────────────────────────────────────
// Copied entry-by-entry, not as a single cp(ROOT, DIST): Node's fs.cp()
// refuses to copy a directory into a subdirectory of itself
// (ERR_FS_CP_EINVAL) before it ever consults `filter`, and DIST lives
// inside ROOT. Per-entry copying sidesteps that guard while keeping the
// same deny-list semantics — a new top-level file or directory ships by
// default unless it's named in NOT_OUTPUT.
//
// Concurrent Playwright workers can each be mid-build into their own
// `.test-dist-<pid>-<rand>/` (see tests/fixtures/buildAndServeFrontend.ts)
// at the same time as this one; `entry.name === DIST_NAME` only excludes
// THIS build's own output directory, not a sibling worker's. Without the
// prefix check below, this loop would try to copy another worker's
// in-progress (or just-deleted, once its test finishes) output directory
// into this one's — at best wasted work, at worst an ENOENT mid-`cp()` when
// that worker's `close()` deletes it out from under this copy.
for (const entry of await readdir(ROOT, { withFileTypes: true })) {
  if (NOT_OUTPUT.has(entry.name) || entry.name.startsWith('.test-dist-')) continue;
  await cp(path.join(ROOT, entry.name), path.join(DIST, entry.name), { recursive: true });
}

// ── 3. assert the deploy is not silently empty ─────────────────────────────
for (const f of ['dashboard.html', 'index.html', 'visit.html', 'resident.html',
                 'apt.html', 'dashboard.js', 'visit.js', 'resident.js', 'apt.js',
                 'error-reporting.js', 'vercel.json', 'styles/register.css',
                 'styles/brand.css']) {
  // vercel.json must reach dist/ for the rewrites to apply to the output dir.
  if (f === 'vercel.json') { await cp(path.join(ROOT, f), path.join(DIST, f)); continue; }
  if (!existsSync(path.join(DIST, f))) throw new Error(`build: dist/${f} is missing`);
}
console.log('built dist/ ->', DIST);
