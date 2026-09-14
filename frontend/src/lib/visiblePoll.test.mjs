import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startVisiblePoll } from './visiblePoll.js';

function fakeDoc() {
  const ls = new Set();
  return {
    hidden: false,
    addEventListener: (_e, f) => ls.add(f),
    removeEventListener: (_e, f) => ls.delete(f),
    _fire() { for (const f of ls) f(); },
    get _listeners() { return ls.size; },
  };
}

test('polls while visible', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const doc = fakeDoc(); let n = 0;
  const stop = startVisiblePoll({ fn: () => n++, ms: 1000, doc });
  t.mock.timers.tick(3000);
  assert.equal(n, 3);
  stop();
});

test('stops while hidden and catches up on return', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const doc = fakeDoc(); let n = 0;
  const stop = startVisiblePoll({ fn: () => n++, ms: 1000, doc });
  doc.hidden = true; doc._fire();
  t.mock.timers.tick(10000);
  assert.equal(n, 0, 'a hidden tab must not poll at all');
  doc.hidden = false; doc._fire();
  assert.equal(n, 1, 'becoming visible refreshes immediately');
  t.mock.timers.tick(2000);
  assert.equal(n, 3);
  stop();
});

test('does not start while already hidden', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const doc = fakeDoc(); doc.hidden = true; let n = 0;
  const stop = startVisiblePoll({ fn: () => n++, ms: 1000, doc });
  t.mock.timers.tick(5000);
  assert.equal(n, 0);
  stop();
});

test('stop() removes the listener and the timer', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const doc = fakeDoc(); let n = 0;
  const stop = startVisiblePoll({ fn: () => n++, ms: 1000, doc });
  stop();
  assert.equal(doc._listeners, 0);
  t.mock.timers.tick(5000);
  assert.equal(n, 0);
});

test('a throwing fn does not kill the loop', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const doc = fakeDoc(); const errs = []; let n = 0;
  const stop = startVisiblePoll({
    fn: () => { n++; if (n === 1) throw new Error('boom'); },
    ms: 1000, doc, onError: e => errs.push(e),
  });
  t.mock.timers.tick(3000);
  assert.equal(n, 3);
  assert.equal(errs.length, 1);
  stop();
});
