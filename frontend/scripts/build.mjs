// The LotLogic frontend build.
//   1. bundle the dashboard's JSX into dist/dashboard.js
//   2. stage every static file into dist/ (dist IS the Vercel output directory)
// Deliberately one file with no config language: the whole build should be
// readable in one sitting by whoever is on call.
import { build } from 'esbuild';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DEV = process.argv.includes('--dev');

// Files and directories that are inputs, not output. Deny-list, not
// allow-list: a new page must ship by default, never be silently dropped.
const NOT_OUTPUT = new Set([
  'dist', 'node_modules', 'src', 'scripts',
  'package.json', 'package-lock.json', '.npmrc', 'vercel.json',
  'Dockerfile', 'nginx.conf', 'railway.toml',
]);

// ── 1. the dashboard bundle ────────────────────────────────────────────────
await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const result = await build({
  entryPoints: [path.join(ROOT, 'src/dashboard.jsx')],
  outdir: DIST,
  entryNames: 'dashboard',
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
for (const entry of await readdir(ROOT, { withFileTypes: true })) {
  if (NOT_OUTPUT.has(entry.name)) continue;
  await cp(path.join(ROOT, entry.name), path.join(DIST, entry.name), { recursive: true });
}

// ── 3. assert the deploy is not silently empty ─────────────────────────────
for (const f of ['dashboard.html', 'index.html', 'visit.html', 'resident.html',
                 'apt.html', 'dashboard.js', 'error-reporting.js', 'vercel.json']) {
  // vercel.json must reach dist/ for the rewrites to apply to the output dir.
  if (f === 'vercel.json') { await cp(path.join(ROOT, f), path.join(DIST, f)); continue; }
  if (!existsSync(path.join(DIST, f))) throw new Error(`build: dist/${f} is missing`);
}
console.log('built dist/ ->', DIST);
