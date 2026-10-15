// The two lot-status wrappers hit the contract's routes with the property id
// (and plate) as query parameters, encoded.
import test from 'node:test';
import assert from 'node:assert/strict';

import { getLotStatus, getPlateTimeline, requestsApi } from '../src/lib/requestsApi.js';

async function seenUrl(call) {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try { await call(); } finally { globalThis.fetch = realFetch; }
  return seen[0];
}

test('getLotStatus asks for the property and nothing else', async () => {
  const url = await seenUrl(() => getLotStatus('p 1'));
  assert.ok(url.endsWith('/apartment/passes/lot-status?property_id=p+1'), url);
  assert.equal(requestsApi.getLotStatus, getLotStatus);
});

test('getPlateTimeline sends the plate as typed, encoded', async () => {
  const url = await seenUrl(() => getPlateTimeline('p1', 'AB&C 12'));
  assert.ok(url.endsWith('/apartment/passes/timeline?property_id=p1&plate=AB%26C+12'), url);
  assert.equal(requestsApi.getPlateTimeline, getPlateTimeline);
});
