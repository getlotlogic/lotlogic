import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// RECOVERY.md lives at the repo root, two levels above this file
// (frontend/scripts/recoveryDoc.test.mjs -> frontend -> repo root).
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DOC_PATH = path.join(REPO_ROOT, 'RECOVERY.md');

function doc() {
  return readFileSync(DOC_PATH, 'utf8');
}

test('RECOVERY.md has a §12 Rollback section with exactly the three numbered rollback procedures', () => {
  const text = doc();
  assert.match(text, /^## 12\. Rollback/m, 'missing "## 12. Rollback" heading');
  const subsections = text.match(/^### 12\.[123] /gm) || [];
  assert.equal(subsections.length, 3, `expected §§12.1/12.2/12.3, found ${subsections.length}`);
});

test('the stale 17-function count is gone everywhere in the doc', () => {
  assert.doesNotMatch(doc(), /17 live/, 'RECOVERY.md still claims 17 live edge functions');
});

test('test-resend-probe is documented as a ghost function, not listed as a live/deployable one', () => {
  const text = doc();
  assert.doesNotMatch(
    text,
    /test-resend-probe \(throwaway/,
    'test-resend-probe should no longer be listed among the deployable functions'
  );
  assert.match(text, /test-resend-probe/, 'test-resend-probe should still be named as a no-source ghost function');
  assert.match(text, /system-notice/, 'system-notice should be named as a no-source ghost function');
});

test('§4 claims exactly 16 live (in-repo) functions and names every slug the deploy matrix actually deploys', () => {
  const text = doc();
  assert.match(text, /## 4\. Edge functions \(16 live/);

  const slugsPath = path.join(REPO_ROOT, 'supabase/functions/_ci/slugs.mjs');
  const raw = execFileSync('node', [slugsPath, 'list'], { encoding: 'utf8' });
  const slugs = JSON.parse(raw);

  assert.equal(slugs.length, 16, `slugs.mjs reports ${slugs.length} slugs, expected 16`);
  for (const slug of slugs) {
    assert.ok(text.includes(slug), `§4 does not mention deployed slug "${slug}"`);
  }
});

test('frontend-repo paths RECOVERY.md cites for this repo exist on this branch', () => {
  const relPaths = [
    '.github/workflows/edge-functions.yml',
    'supabase/config.toml',
    'cloudflare-workers/email-tow-action',
    'supabase/functions/_ci/slugs.mjs',
  ];
  for (const rel of relPaths) {
    assert.ok(existsSync(path.join(REPO_ROOT, rel)), `RECOVERY.md cites "${rel}" but it does not exist here`);
  }
});
