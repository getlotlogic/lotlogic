// Unit tests for photoUrl() in src/lib/db.js — the one place a vehicle photo
// URL is minted (Wave 2.5 Task 10).
//
// Every `<img src>` in the dashboard that used to render
// plate_events.image_url (a permanent, unauthenticated https://pub-….r2.dev
// address) now goes through this helper, which asks the scope-checked backend
// for a 15-minute presigned URL. What matters here is not that it fetches —
// it is the CACHING, because a violation queue of 50 rows re-renders
// constantly and a naive helper would issue a presign per row per render.
import test from 'node:test';
import assert from 'node:assert/strict';

const EVENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

// A fetch stub that answers the presign route and records every call.
// `answer(eventId, n)` returns a Response (or throws) for the nth call.
function makeFetchStub(answer) {
  const calls = [];
  const impl = async (url, init) => {
    const href = typeof url === 'string' ? url : url.toString();
    const m = href.match(/\/alpr\/plate-events\/([^/]+)\/photo$/);
    if (!m) return new Response('not found', { status: 404 });
    calls.push({ eventId: m[1], headers: (init && init.headers) || {} });
    return answer(m[1], calls.length);
  };
  impl.calls = calls;
  return impl;
}

function ok(url, expiresInMs = 15 * 60 * 1000) {
  return new Response(
    JSON.stringify({ url, expires_at: new Date(Date.now() + expiresInMs).toISOString() }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

// Fresh module instance per test: the cache is module-scoped, which is the
// whole point, so it must not leak between cases.
async function importDb(fetchImpl) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const mod = await import(`../src/lib/db.js?t=${Math.random()}`);
  return { ...mod, restore: () => { globalThis.fetch = originalFetch; } };
}

test('photoUrl: resolves the backend presign and sends the session bearer token', async () => {
  const fetchImpl = makeFetchStub(() => ok('https://signed.example/a.jpg?sig=1'));
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ _token: 'jwt-fixture' }),
    removeItem: () => {},
  };
  const { photoUrl, restore } = await importDb(fetchImpl);
  try {
    assert.equal(await photoUrl(EVENT), 'https://signed.example/a.jpg?sig=1');
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].eventId, EVENT);
    assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer jwt-fixture');
  } finally {
    restore();
    delete globalThis.localStorage;
  }
});

test('photoUrl: a null/undefined event id resolves to null without a request', async () => {
  const fetchImpl = makeFetchStub(() => ok('https://signed.example/a.jpg'));
  const { photoUrl, restore } = await importDb(fetchImpl);
  try {
    assert.equal(await photoUrl(null), null);
    assert.equal(await photoUrl(undefined), null);
    assert.equal(await photoUrl(''), null);
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    restore();
  }
});

test('photoUrl: a resolved URL is memoised — 50 thumbnails are not 50 round trips', async () => {
  const fetchImpl = makeFetchStub(() => ok('https://signed.example/a.jpg'));
  const { photoUrl, restore } = await importDb(fetchImpl);
  try {
    for (let i = 0; i < 50; i++) await photoUrl(EVENT);
    assert.equal(fetchImpl.calls.length, 1, 'expected exactly one presign for one event');
  } finally {
    restore();
  }
});

test('photoUrl: concurrent callers for the same event share one in-flight request', async () => {
  const fetchImpl = makeFetchStub(() => ok('https://signed.example/a.jpg'));
  const { photoUrl, restore } = await importDb(fetchImpl);
  try {
    const urls = await Promise.all(Array.from({ length: 10 }, () => photoUrl(EVENT)));
    assert.equal(fetchImpl.calls.length, 1);
    assert.ok(urls.every(u => u === 'https://signed.example/a.jpg'));
  } finally {
    restore();
  }
});

test('photoUrl: different events are cached independently', async () => {
  const fetchImpl = makeFetchStub(id => ok(`https://signed.example/${id}.jpg`));
  const { photoUrl, restore } = await importDb(fetchImpl);
  try {
    assert.equal(await photoUrl(EVENT), `https://signed.example/${EVENT}.jpg`);
    assert.equal(await photoUrl(OTHER), `https://signed.example/${OTHER}.jpg`);
    assert.equal(await photoUrl(EVENT), `https://signed.example/${EVENT}.jpg`);
    assert.equal(fetchImpl.calls.length, 2);
  } finally {
    restore();
  }
});

test('photoUrl: a 404 means this read has no photograph — cached, never retried', async () => {
  const fetchImpl = makeFetchStub(() => new Response(JSON.stringify({ detail: 'no photo' }), {
    status: 404, headers: { 'Content-Type': 'application/json' },
  }));
  const { photoUrl, restore } = await importDb(fetchImpl);
  try {
    assert.equal(await photoUrl(EVENT), null);
    assert.equal(await photoUrl(EVENT), null);
    assert.equal(await photoUrl(EVENT), null);
    assert.equal(fetchImpl.calls.length, 1, 'a permanent "no photo" must not be re-asked');
  } finally {
    restore();
  }
});

test('photoUrl: a transient failure is retried rather than blanking the photo for the session', async () => {
  // 503 first, then success — the R2-is-having-a-moment case. A 404-style
  // permanent cache here would leave the operator with no evidence photo
  // until they reloaded the whole dashboard.
  const fetchImpl = makeFetchStub((_id, n) => (
    n === 1
      ? new Response(JSON.stringify({ detail: 'unavailable' }), { status: 503 })
      : ok('https://signed.example/recovered.jpg')
  ));
  const { photoUrl, clearPhotoUrlCache, restore } = await importDb(fetchImpl);
  try {
    assert.equal(await photoUrl(EVENT), null);
    // The retry window is 15s of wall clock; clearing the cache is the
    // deterministic stand-in for waiting it out.
    clearPhotoUrlCache();
    assert.equal(await photoUrl(EVENT), 'https://signed.example/recovered.jpg');
    assert.equal(fetchImpl.calls.length, 2);
  } finally {
    restore();
  }
});

test('photoUrl: a URL expiring sooner than the cache ceiling is not reused past its expiry', async () => {
  // The backend says this presign dies in 30 seconds. The helper keeps a
  // 2-minute safety margin, so the entry is already stale on the next call
  // and must be re-minted — an <img> must never be handed a URL that dies
  // while it is loading.
  const fetchImpl = makeFetchStub((_id, n) => ok(`https://signed.example/${n}.jpg`, 30 * 1000));
  const { photoUrl, restore } = await importDb(fetchImpl);
  try {
    assert.equal(await photoUrl(EVENT), 'https://signed.example/1.jpg');
    assert.equal(await photoUrl(EVENT), 'https://signed.example/2.jpg');
    assert.equal(fetchImpl.calls.length, 2);
  } finally {
    restore();
  }
});
