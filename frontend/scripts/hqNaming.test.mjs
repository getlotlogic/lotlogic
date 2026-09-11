import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORDS = /\b(resident|visitor|permanent|temporary|guest|driver)s?\b/i;

function hqFiles() {
  const files = [path.join(ROOT, 'src/pages/HqPage.jsx'),
                 path.join(ROOT, 'src/lib/brainApi.js')];
  const dir = path.join(ROOT, 'src/pages/hq');
  for (const entry of readdirSync(dir)) files.push(path.join(dir, entry));
  return files;
}

test('no HQ source file uses a forbidden word', () => {
  for (const file of hqFiles()) {
    const hit = readFileSync(file, 'utf8').match(WORDS);
    assert.equal(hit, null, `${path.basename(file)} uses "${hit?.[0]}" — say "parking pass"`);
  }
});

test('the checker is looking at files that exist', () => {
  assert.ok(hqFiles().length >= 3);
});
