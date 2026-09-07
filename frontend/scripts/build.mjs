// The LotLogic frontend build.
//   1. bundle the dashboard's JSX into dist/dashboard.js
//   2. stage every static file into dist/ (dist IS the Vercel output directory)
// Deliberately one file with no config language: the whole build should be
// readable in one sitting by whoever is on call.
import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
// TASK 1 ONLY: the JSX still lives inside dashboard.html. Pull it out into a
// temp file so the build is real while the HTML stays byte-identical. Task 2
// replaces this block with `entryPoints: ['src/dashboard.jsx']`.
const html = await readFile(path.join(ROOT, 'dashboard.html'), 'utf8');
const OPEN = '<script type="text/babel">\n';
const start = html.indexOf(OPEN);
if (start < 0) throw new Error('dashboard.html: no <script type="text/babel"> block');
const end = html.indexOf('\n</script>', start);
if (end < 0) throw new Error('dashboard.html: unterminated <script type="text/babel">');
const entry = path.join(ROOT, 'dashboard.scriptblock.jsx');
await writeFile(entry, html.slice(start + OPEN.length, end + 1));

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const result = await build({
  entryPoints: [entry],
  outfile: path.join(DIST, 'dashboard.js'),
  bundle: true,
  format: 'iife',
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
await rm(entry, { force: true });

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
