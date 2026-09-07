// Tests for the naming guard (Ruling S3-k). Each case builds a throwaway
// "frontend/" containing nothing but scripts/check-naming.mjs, a couple of
// tiny HTML files and an allow-list, then runs the guard against it. The
// script derives its ROOT as `import.meta.dirname/..`, so a copy of the
// script inside <tmp>/scripts/ makes <tmp> the tree under test — no need to
// clone the real site, and no chance of a test asserting against live copy
// that someone later edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GUARD = path.resolve(import.meta.dirname, 'check-naming.mjs');
const SCRATCH = '/private/tmp/claude-501/-Users-gabe/16382c27-5cfe-4c64-a900-76278515b0bf/scratchpad';

// files: { 'index.html': '<p>…</p>', 'blog/x.html': … }; allowlist: string
function runGuard(files, allowlist = '') {
  const root = fs.mkdtempSync(path.join(SCRATCH, 'naming-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(GUARD, path.join(root, 'scripts', 'check-naming.mjs'));
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    if (allowlist) fs.writeFileSync(path.join(root, '.naming-allowlist'), allowlist);
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-naming.mjs')], {
      encoding: 'utf8',
    });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('clean copy passes', () => {
  const r = runGuard({ 'index.html': '<p>Every parking pass registers via QR.</p>' });
  assert.equal(r.status, 0, r.out);
});

test('an injected violation fails', () => {
  const r = runGuard({ 'index.html': '<p>Temporary passes register via QR.</p>' });
  assert.equal(r.status, 1);
  assert.match(r.out, /Temporary passes register/);
});

test('an allow-listed phrase exempts only itself, not the whole node', () => {
  // One text node, two hits: the allow-listed one and a real violation. The
  // old guard blessed the entire node as soon as the phrase matched.
  const r = runGuard(
    { 'index.html': '<p>You send a driver to patrol. Temporary passes register via QR.</p>' },
    'index.html: You send a driver to patrol  # ok\n',
  );
  assert.equal(r.status, 1, 'the un-allow-listed half of the node must still fail');
  assert.match(r.out, /Temporary passes register/);
});

test('an allow-listed phrase on its own passes', () => {
  const r = runGuard(
    { 'index.html': '<p>You send a driver to patrol.</p>' },
    'index.html: You send a driver to patrol  # ok\n',
  );
  assert.equal(r.status, 0, r.out);
});

test('a stale allow-list entry fails', () => {
  const r = runGuard(
    { 'index.html': '<p>Every parking pass registers via QR.</p>' },
    'index.html: a driver who no longer appears here  # ok\n',
  );
  assert.equal(r.status, 1);
  assert.match(r.out, /stale entries/);
});

test('an allow-list entry naming a file that does not exist is stale', () => {
  const r = runGuard(
    { 'index.html': '<p>Every parking pass registers via QR.</p>' },
    'blog/renamed-away.html: You send a driver to patrol  # ok\n',
  );
  assert.equal(r.status, 1);
  assert.match(r.out, /stale entries/);
});

test('single-quoted attribute values are scanned', () => {
  const r = runGuard({ 'index.html': "<img src='a.png' alt='Temporary pass holder'>" });
  assert.equal(r.status, 1, 'alt=\'…\' must be checked, not just alt="…"');
  assert.match(r.out, /Temporary pass holder/);
});

test('nested marketing subdirectories are scanned', () => {
  // The old guard walked a hard-coded ['blog', 'policy'] only.
  const r = runGuard({ 'guides/charlotte/deep.html': '<p>Temporary passes here.</p>' });
  assert.equal(r.status, 1, 'every frontend/**/*.html must be walked');
  assert.match(r.out, /guides\/charlotte\/deep\.html/);
});

test('build and source directories are not scanned', () => {
  const r = runGuard({
    'dist/index.html': '<p>Temporary passes here.</p>',
    'node_modules/pkg/x.html': '<p>Temporary passes here.</p>',
    '.test-dist-abc/index.html': '<p>Temporary passes here.</p>',
    'index.html': '<p>Every parking pass registers via QR.</p>',
  });
  assert.equal(r.status, 0, r.out);
});
