import test from 'node:test';
import assert from 'node:assert/strict';
import { latestGate, applyIfCurrent } from '../src/lib/latest.js';

test('only the most recently taken ticket is current', () => {
  const gate = latestGate();
  const first = gate.take();
  const second = gate.take();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  const third = gate.take();
  assert.equal(gate.isCurrent(second), false);
  assert.equal(gate.isCurrent(third), true);
});

test('gates are independent of each other', () => {
  const a = latestGate();
  const b = latestGate();
  const ta = a.take();
  b.take();
  b.take();
  assert.equal(a.isCurrent(ta), true);
});

// Drives the gate the way RequestsSection.load() does: a poll starts, the user
// extends, the post-extend reload starts, and the older response lands last.
test('an older response resolving after a newer one cannot overwrite it', async () => {
  const gate = latestGate();
  let shown = null;
  const load = async (fetchRow) => {
    const ticket = gate.take();
    const row = await fetchRow();
    if (!gate.isCurrent(ticket)) return;
    shown = row;
  };
  let releasePoll;
  const slowPoll = new Promise((res) => { releasePoll = () => res({ extension_count: 0 }); });
  const poll = load(() => slowPoll);
  const afterExtend = load(async () => ({ extension_count: 1 }));
  await afterExtend;
  assert.deepEqual(shown, { extension_count: 1 });
  releasePoll();
  await poll;
  assert.deepEqual(shown, { extension_count: 1 });
});

test('a stale failure is dropped too', async () => {
  const gate = latestGate();
  let error = '';
  const load = async (fetchRow) => {
    const ticket = gate.take();
    try { await fetchRow(); } catch { if (gate.isCurrent(ticket)) error = 'boom'; }
  };
  let rejectOld;
  const old = load(() => new Promise((_, rej) => { rejectOld = () => rej(new Error('x')); }));
  await load(async () => ({}));
  rejectOld();
  await old;
  assert.equal(error, '');
});

test('applyIfCurrent runs only for the newest ticket and reports it', () => {
  const gate = latestGate();
  const old = gate.take();
  const fresh = gate.take();
  let ran = [];
  assert.equal(applyIfCurrent(gate, old, () => ran.push('old')), false);
  assert.equal(applyIfCurrent(gate, fresh, () => ran.push('fresh')), true);
  assert.deepEqual(ran, ['fresh']);
});

// remove() takes a ticket: a poll that started before the click carries the
// removed row and must not bring it back when it lands.
test('a poll in flight during remove() cannot restore the removed row', async () => {
  const gate = latestGate();
  let rows = [{ id: 1 }, { id: 2 }];
  let release;
  const slow = new Promise((res) => { release = () => res([{ id: 1 }, { id: 2 }]); });
  const poll = (async () => {
    const t = gate.take();
    const items = await slow;
    applyIfCurrent(gate, t, () => { rows = items; });
  })();
  gate.take(); // remove(): retire in-flight polls
  rows = rows.filter((r) => r.id !== 1);
  release();
  await poll;
  assert.deepEqual(rows, [{ id: 2 }]);
});

test('RequestsSection applies list responses through applyIfCurrent and tickets every direct write', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/pages/property/RequestsSection.jsx', import.meta.url), 'utf8');
  assert.match(src, /applyIfCurrent\(gate, ticket,/);
  const remove = src.slice(src.indexOf('async function remove('), src.indexOf('function showUndo('));
  assert.match(remove, /loadGateRef\.current\.take\(\)/);
});
