// Unit tests for lazyPage()'s stale-chunk reload logic. React.lazy() itself
// isn't exercised here (that needs a DOM + Suspense render) — these tests
// stub `sessionStorage` / `location` and drive the loader function that
// lazyPage() hands to React.lazy directly, since that loader is where all
// the reload-vs-rethrow decision-making lives.
import test from 'node:test';
import assert from 'node:assert/strict';

const CHUNK_RELOAD_KEY = 'lotlogic:chunk-reload';

// Minimal in-memory sessionStorage stub.
function makeSessionStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
}

// lazyPage() calls React.lazy(loaderWrapper) — we only need the wrapper
// function it constructs, so stub out `react` with a lazy() that just
// returns whatever function it's given, uncalled. That lets us invoke the
// wrapper ourselves and assert on its behavior without rendering anything.
async function importLazyPageWithStubs({ sessionStorage, reload, now }) {
  globalThis.sessionStorage = sessionStorage;
  globalThis.location = { reload };
  const originalNow = Date.now;
  if (typeof now === 'number') Date.now = () => now;

  // Bust the module cache per-test via a unique query string so each test
  // gets a fresh evaluation (harmless here since the module is stateless,
  // but keeps tests independent of import order/caching).
  const mod = await import(`../src/lib/lazyPage.js?t=${Math.random()}`);

  return {
    lazyPage: mod.lazyPage,
    restore: () => { Date.now = originalNow; },
  };
}

// React.lazy() wraps its argument in an internal payload we can't unwrap
// from the outside, and rendering a real Suspense tree just to observe
// resolve/reject timing is more machinery than this needs. Instead, each
// test monkeypatches `react`'s `lazy` export to capture the loader function
// lazyPage() builds, then calls that loader directly and asserts on its
// reload/rethrow/clear behavior.

test('first failure: reloads once and sets the flag', async () => {
  const reloadCalls = [];
  const sessionStorage = makeSessionStorage();
  const { lazyPage, restore } = await importLazyPageWithStubs({
    sessionStorage,
    reload: () => reloadCalls.push(Date.now()),
    now: 1_000,
  });

  let capturedLoader;
  const realReact = await import('react');
  const originalLazy = realReact.default.lazy;
  realReact.default.lazy = (fn) => { capturedLoader = fn; return {}; };

  try {
    const failingLoader = () => Promise.reject(new Error('404: chunk missing'));
    lazyPage(failingLoader);
    assert.equal(typeof capturedLoader, 'function');

    await assert.rejects(() => capturedLoader(), /404: chunk missing/);
    assert.equal(reloadCalls.length, 1, 'location.reload() should be called once');
    assert.equal(sessionStorage.getItem(CHUNK_RELOAD_KEY), '1000', 'flag should be set to Date.now()');
  } finally {
    realReact.default.lazy = originalLazy;
    restore();
  }
});

test('second failure within 60s: rethrows without reloading again', async () => {
  const reloadCalls = [];
  const sessionStorage = makeSessionStorage({ [CHUNK_RELOAD_KEY]: '1000' });
  const { lazyPage, restore } = await importLazyPageWithStubs({
    sessionStorage,
    reload: () => reloadCalls.push(Date.now()),
    now: 1_000 + 30_000, // 30s later, inside the 60s window
  });

  let capturedLoader;
  const realReact = await import('react');
  const originalLazy = realReact.default.lazy;
  realReact.default.lazy = (fn) => { capturedLoader = fn; return {}; };

  try {
    const failingLoader = () => Promise.reject(new Error('404: chunk missing'));
    lazyPage(failingLoader);

    await assert.rejects(() => capturedLoader(), /404: chunk missing/);
    assert.equal(reloadCalls.length, 0, 'location.reload() should NOT be called again within the window');
    assert.equal(sessionStorage.getItem(CHUNK_RELOAD_KEY), '1000', 'flag should be left untouched');
  } finally {
    realReact.default.lazy = originalLazy;
    restore();
  }
});

test('successful import clears the flag', async () => {
  const reloadCalls = [];
  const sessionStorage = makeSessionStorage({ [CHUNK_RELOAD_KEY]: '1000' });
  const { lazyPage, restore } = await importLazyPageWithStubs({
    sessionStorage,
    reload: () => reloadCalls.push(Date.now()),
    now: 1_000 + 5_000,
  });

  let capturedLoader;
  const realReact = await import('react');
  const originalLazy = realReact.default.lazy;
  realReact.default.lazy = (fn) => { capturedLoader = fn; return {}; };

  try {
    const okModule = { default: () => null };
    const succeedingLoader = () => Promise.resolve(okModule);
    lazyPage(succeedingLoader);

    const result = await capturedLoader();
    assert.equal(result, okModule);
    assert.equal(reloadCalls.length, 0);
    assert.equal(sessionStorage.getItem(CHUNK_RELOAD_KEY), null, 'flag should be cleared after success');
  } finally {
    realReact.default.lazy = originalLazy;
    restore();
  }
});

test('storage that throws on write: rethrows without reloading', async () => {
  // Safari private mode, or a full quota. The stored flag is the only guard
  // against reloading forever, so if it cannot be written the page must not
  // reload at all — it must fall through to the ErrorBoundary. Before this
  // was fixed the write was swallowed, reload() fired, and the next load
  // read back a null flag and reloaded again: an endless refresh.
  const reloadCalls = [];
  const throwingStorage = {
    getItem: () => null,
    setItem: () => { throw new DOMException('QuotaExceededError'); },
    removeItem: () => { throw new DOMException('QuotaExceededError'); },
  };
  const { lazyPage, restore } = await importLazyPageWithStubs({
    sessionStorage: throwingStorage,
    reload: () => reloadCalls.push(Date.now()),
    now: 1_000,
  });

  let capturedLoader;
  const realReact = await import('react');
  const originalLazy = realReact.default.lazy;
  realReact.default.lazy = (fn) => { capturedLoader = fn; return {}; };

  try {
    const failingLoader = () => Promise.reject(new Error('404: chunk missing'));
    lazyPage(failingLoader);

    await assert.rejects(() => capturedLoader(), /404: chunk missing/);
    assert.equal(
      reloadCalls.length, 0,
      'location.reload() must NOT be called when the guard flag could not be stored'
    );
  } finally {
    realReact.default.lazy = originalLazy;
    restore();
  }
});

test('storage that throws on write: a successful import still resolves', async () => {
  // The success path also writes (to clear the flag). A throwing storage
  // there must not turn a working import into a failure.
  const throwingStorage = {
    getItem: () => null,
    setItem: () => { throw new DOMException('QuotaExceededError'); },
    removeItem: () => { throw new DOMException('QuotaExceededError'); },
  };
  const { lazyPage, restore } = await importLazyPageWithStubs({
    sessionStorage: throwingStorage,
    reload: () => { throw new Error('reload should not happen'); },
    now: 1_000,
  });

  let capturedLoader;
  const realReact = await import('react');
  const originalLazy = realReact.default.lazy;
  realReact.default.lazy = (fn) => { capturedLoader = fn; return {}; };

  try {
    const okModule = { default: () => null };
    lazyPage(() => Promise.resolve(okModule));
    assert.equal(await capturedLoader(), okModule);
  } finally {
    realReact.default.lazy = originalLazy;
    restore();
  }
});
