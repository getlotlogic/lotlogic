// Unit tests for src/lib/e2e.js — the gate on the `?e2e=1` test surface and
// on the portal suite's backend-origin override (`window.__LOTLOGIC_API__`).
// The override must be impossible on the production hostnames and without
// the e2e flag: it decides which backend a signed-in browser talks to.
import test from 'node:test';
import assert from 'node:assert/strict';

import { isE2E, e2eApiOverride } from '../src/lib/e2e.js';
import { API, PRODUCTION_API } from '../src/lib/api.js';

const LOCAL = 'http://localhost:8010';
const env = (o) => ({ hostname: '127.0.0.1', search: '', flag: null, override: undefined, ...o });

test('isE2E: the query flag or the storage flag, off the production hostnames', () => {
  assert.equal(isE2E(env({ search: '?e2e=1' })), true);
  assert.equal(isE2E(env({ flag: '1' })), true);
  assert.equal(isE2E(env({})), false);
  assert.equal(isE2E(env({ search: '?e2e=0' })), false);
  assert.equal(isE2E(env({ hostname: 'lotlogicparking.com', search: '?e2e=1', flag: '1' })), false);
  assert.equal(isE2E(env({ hostname: 'www.lotlogicparking.com', flag: '1' })), false);
  assert.equal(isE2E(null), false);
});

test('e2eApiOverride: honoured only under the e2e flag', () => {
  assert.equal(e2eApiOverride(env({ flag: '1', override: LOCAL })), LOCAL);
  assert.equal(e2eApiOverride(env({ search: '?e2e=1', override: LOCAL + '/ignored/path' })), LOCAL);
  assert.equal(e2eApiOverride(env({ override: LOCAL })), null);
});

test('e2eApiOverride: never on the production hostnames', () => {
  assert.equal(e2eApiOverride(env({ hostname: 'lotlogicparking.com', flag: '1', override: LOCAL })), null);
});

test('e2eApiOverride: only an absolute http(s) origin', () => {
  for (const bad of ['javascript:alert(1)', 'localhost:8010', '', 42, null, 'ftp://x.test']) {
    assert.equal(e2eApiOverride(env({ flag: '1', override: bad })), null, String(bad));
  }
});

test('api.js falls back to the production origin with no browser at all', () => {
  assert.equal(API, PRODUCTION_API);
  assert.equal(PRODUCTION_API, 'https://lotlogic-backend-production.up.railway.app');
});
