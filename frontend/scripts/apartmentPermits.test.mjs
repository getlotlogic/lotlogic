// ApartmentPermits' pending queue offers one "View …" button per document a
// row actually carries — the has_* flags GET /apartment/permits derives from
// the *_doc_url columns. The vehicle registration card is the fourth kind
// (Task F1). The component is JSX with hooks and this repo has no DOM to
// render it in, so — like accountPassword.test.mjs and propertySettings.test.mjs —
// the contract is pinned at the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = readFileSync(path.resolve(import.meta.dirname, '../src/pages/ApartmentPermits.jsx'), 'utf8');

// docButtons' source up to its `.filter(` — the [which, label, present] tuples.
function docButtonsHead() {
  const start = SRC.indexOf('const docButtons = (row, kind) =>');
  assert.notEqual(start, -1, 'docButtons is gone from ApartmentPermits.jsx');
  const end = SRC.indexOf('.filter(', start);
  assert.ok(end > start, 'docButtons no longer filters out documents a row does not carry');
  return { head: SRC.slice(start, end), end };
}

test('docButtons offers ID, Lease, Registration, Plate — in that order, each on its own has_* flag', () => {
  const tuples = [...docButtonsHead().head.matchAll(/\[\s*'([a-z]+)'\s*,\s*'([^']+)'\s*,\s*row\.(\w+)\s*\]/g)]
    .map(m => [m[1], m[2], m[3]]);
  assert.deepEqual(tuples, [
    ['id', 'ID', 'has_id'],
    ['lease', 'Lease', 'has_lease'],
    ['registration', 'Registration', 'has_registration'],
    ['plate', 'Plate', 'has_plate'],
  ]);
});

test('a document the row does not carry gets no button (short-term rows have no has_registration)', () => {
  const { end } = docButtonsHead();
  assert.match(SRC.slice(end, end + 60), /^\.filter\(\(\[, , present\]\) => present\)/);
});
