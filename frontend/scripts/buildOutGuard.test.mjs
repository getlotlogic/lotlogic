// Regression test for the LOTLOGIC_BUILD_OUT destructive-path guard in
// build.mjs. A reviewer found that LOTLOGIC_BUILD_OUT='.' (or '..', or an
// absolute path) makes `DIST` resolve outside (or to the root of)
// `frontend/`, and `rm(DIST, { recursive: true, force: true })` then deletes
// the frontend source tree instead of a build output directory.
//
// This spawns `node scripts/build.mjs` against a TEMP COPY of frontend/ (not
// the real tree) so that if the guard ever regresses, the `rm` it's supposed
// to prevent can only destroy scratch files, never this repo. The copy lives
// inside its own throwaway container directory specifically so that even the
// '..' and 'dist/../..' cases — which resolve to the copy's *parent* — can
// only ever wipe that disposable container, not anything else on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL_FRONTEND = path.resolve(import.meta.dirname, '..');
const SCRATCH_ROOT = os.tmpdir();
const SENTINEL_NAME = '.build-guard-test-sentinel';
const SENTINEL_CONTENT = 'if you can read this, LOTLOGIC_BUILD_OUT did not delete the tree';

// Copies frontend/ (minus node_modules/dist/.test-dist-*) into a fresh
// container directory and symlinks node_modules back in, so esbuild resolves
// normally without a ~30MB copy on every test run. Returns { containerDir,
// copyDir } — containerDir is the thing safe to `rm -rf` in cleanup, copyDir
// is the frontend/ stand-in to run `node scripts/build.mjs` from.
function makeFrontendCopy() {
  const containerDir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'build-guard-'));
  const copyDir = path.join(containerDir, 'frontend');
  fs.cpSync(REAL_FRONTEND, copyDir, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== 'node_modules' && base !== 'dist' && !base.startsWith('.test-dist-');
    },
  });
  fs.symlinkSync(path.join(REAL_FRONTEND, 'node_modules'), path.join(copyDir, 'node_modules'));
  fs.writeFileSync(path.join(copyDir, SENTINEL_NAME), SENTINEL_CONTENT);
  return { containerDir, copyDir };
}

function runBuild(copyDir, buildOut) {
  return spawnSync(process.execPath, ['scripts/build.mjs'], {
    cwd: copyDir,
    env: { ...process.env, LOTLOGIC_BUILD_OUT: buildOut },
    encoding: 'utf8',
  });
}

for (const badValue of ['.', '..', '/tmp/x', 'dist/../..']) {
  test(`LOTLOGIC_BUILD_OUT=${JSON.stringify(badValue)} is refused before anything is deleted`, () => {
    const { containerDir, copyDir } = makeFrontendCopy();
    try {
      const result = runBuild(copyDir, badValue);
      assert.equal(result.status, 2, `expected exit 2, got ${result.status}\nstderr: ${result.stderr}`);
      assert.equal(
        fs.readFileSync(path.join(copyDir, SENTINEL_NAME), 'utf8'),
        SENTINEL_CONTENT,
        'frontend/ sentinel must survive a rejected build'
      );
    } finally {
      fs.rmSync(containerDir, { recursive: true, force: true });
    }
  });
}

test("LOTLOGIC_BUILD_OUT='.test-dist-abc' still builds successfully", () => {
  const { containerDir, copyDir } = makeFrontendCopy();
  try {
    const result = runBuild(copyDir, '.test-dist-abc');
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
    const outDir = path.join(copyDir, '.test-dist-abc');
    assert.ok(fs.existsSync(path.join(outDir, 'dashboard.js')), 'dashboard.js should be built into the custom out dir');
    assert.ok(fs.existsSync(path.join(outDir, 'index.html')), 'index.html should be staged into the custom out dir');
    assert.equal(
      fs.readFileSync(path.join(copyDir, SENTINEL_NAME), 'utf8'),
      SENTINEL_CONTENT,
      'frontend/ sentinel must survive a valid build too'
    );
  } finally {
    fs.rmSync(containerDir, { recursive: true, force: true });
  }
});
