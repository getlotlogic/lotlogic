// Unit tests for db.recordAction (Wave 2.2 Task 7, frontend half).
//
// Before this task, recordAction computed gross_revenue/our_revenue from
// browser-held fee values, UPDATEd `violations` directly through Supabase,
// re-armed zone_occupancy itself, and inserted into the nonexistent
// `action_logs` table. All of that moved server-side: recordAction now
// posts to POST /violations/{id}/resolve and does nothing else, except for
// plate_correction, which stays a direct (non-money) Supabase update.
//
// We don't mock the `api.js`/`supabase.js` modules -- apiFetch resolves
// `fetch` from the global scope at call time, so stubbing `globalThis.fetch`
// is enough to intercept the backend call without a module loader. For the
// negative assertion ("no client-side Supabase write happens on this path")
// we monkeypatch the *real*, singleton `supabase.from` to throw -- since
// ES modules are cached by resolved URL, `db.js`'s import of `supabase.js`
// and our own import of the same file share one instance.
import test from 'node:test';
import assert from 'node:assert/strict';

function stubLocalStorage() {
  // getSessionToken() / supabase.js's module-load auth restore both read
  // localStorage inside try/catch, so leaving it undefined is safe too --
  // but a real stub keeps the fetch stub's Authorization-header assertions
  // meaningful (empty session -> no header).
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
}

async function loadModules() {
  stubLocalStorage();
  const { supabase } = await import('../src/lib/supabase.js');
  const { db } = await import('../src/lib/db.js');
  return { db, supabase };
}

test('recordAction(tow) posts to the backend resolve route and sends no fee/revenue fields', async () => {
  const { db, supabase } = await loadModules();

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, violation_id: 'v1', status: 'resolved' }),
    };
  };

  // Prove nothing on this path still writes to Supabase client-side (the
  // old gross_revenue/our_revenue UPDATE, the zone_occupancy re-arm, and
  // the action_logs insert all lived behind supabase.from(...)). If any of
  // that code path were reintroduced, this throws and fails the test.
  const originalFrom = supabase.from;
  supabase.from = () => { throw new Error('recordAction(tow) must not touch Supabase directly'); };

  try {
    const result = await db.recordAction('v1', 'tow', {
      _partner: { id: 'p1', tow_fee: 250, revenue_share: 0.3 }, // must be ignored
      _performerEmail: 'partner@example.com',                   // must be ignored
    });
    assert.deepEqual(result, { success: true });
  } finally {
    globalThis.fetch = originalFetch;
    supabase.from = originalFrom;
  }

  assert.equal(calls.length, 1, 'expected exactly one network call');
  const { url, opts } = calls[0];
  assert.match(url, /\/violations\/v1\/resolve$/);
  assert.equal(opts.method, 'POST');

  const body = JSON.parse(opts.body);
  assert.equal(body.status, 'resolved');
  assert.equal(body.action_taken, 'tow');
  // The whole point of this task: the browser no longer computes or sends
  // gross_revenue / our_revenue / partner_id. Their presence here would mean
  // the client-side fee math (the live half of DB-7) is back.
  assert.equal('gross_revenue' in body, false);
  assert.equal('our_revenue' in body, false);
  assert.equal('partner_id' in body, false);
});

test('recordAction(dismissed) also goes through the backend, not a client-side zone re-arm', async () => {
  const { db, supabase } = await loadModules();

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  const originalFrom = supabase.from;
  supabase.from = () => { throw new Error('recordAction(dismissed) must not touch Supabase directly'); };

  try {
    await db.recordAction('v2', 'dismissed', {});
  } finally {
    globalThis.fetch = originalFetch;
    supabase.from = originalFrom;
  }

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.action_taken, 'dismissed');
  assert.equal('zone_id' in body, false);
});

test('recordAction propagates a backend failure (e.g. the 409 invoiced-at guard)', async () => {
  const { db } = await loadModules();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ detail: 'Cannot change action_taken: violation has been invoiced.' }),
  });

  try {
    await assert.rejects(
      () => db.recordAction('v3', 'tow', {}),
      /Cannot change action_taken/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('recordAction(plate_correction) is unchanged: direct Supabase update, no backend call', async () => {
  const { db, supabase } = await loadModules();

  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { fetchCalls.push({ url, opts }); throw new Error('should not be reached'); };

  const supabaseCalls = [];
  const originalFrom = supabase.from;
  supabase.from = (table) => {
    supabaseCalls.push(table);
    return {
      update: (patch) => ({
        eq: (col, val) => {
          assert.equal(table, 'violations');
          assert.deepEqual(patch, { plate_text: 'ABC123' });
          assert.equal(col, 'id');
          assert.equal(val, 'v4');
          return Promise.resolve({ error: null });
        },
      }),
    };
  };

  try {
    const result = await db.recordAction('v4', 'plate_correction', { plate_text: 'ABC123' });
    assert.deepEqual(result, { success: true });
  } finally {
    globalThis.fetch = originalFetch;
    supabase.from = originalFrom;
  }

  assert.equal(fetchCalls.length, 0, 'plate_correction must not call the backend');
  assert.deepEqual(supabaseCalls, ['violations']);
});
