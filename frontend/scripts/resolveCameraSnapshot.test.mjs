// Unit tests for resolveCameraSnapshot() / tryLoadImageUrl() in src/lib/db.js.
//
// This pair used to live inline in frontend/index.html (added in f4e90c9,
// "Add shared snapshot resolver and fix ViolationProofModal tunnel
// fallback") as the single source of truth for turning a camera id + an
// optional tunnel URL into a displayable "Current" photo. When the
// dashboard was split into modules the definition was dropped, but
// ProofModal.jsx kept calling `resolveCameraSnapshot(...)` — a
// ReferenceError swallowed by the surrounding try/catch, so the camera
// snapshot fallback silently went dead (Wave 2.6 follow-up). These tests
// cover the restored implementation in src/lib/db.js: the DB-snapshot path
// and the tunnel fallback path for a fixture violation event.
import test from 'node:test';
import assert from 'node:assert/strict';

const CAMERA_ID = 'cam_fixture_1';

// Minimal in-memory Image stub. `succeed` controls whether onload or
// onerror fires; naturalWidth must be > 0 for tryLoadImageUrl() to treat
// the load as real (mirrors a broken-image icon reporting width 0).
function makeImageStub({ succeed, naturalWidth = 800 }) {
  return class StubImage {
    constructor() {
      this.naturalWidth = 0;
      this.onload = null;
      this.onerror = null;
    }
    set src(_url) {
      queueMicrotask(() => {
        if (succeed) {
          this.naturalWidth = naturalWidth;
          this.onload && this.onload();
        } else {
          this.onerror && this.onerror();
        }
      });
    }
  };
}

// Builds a fetch stub that answers any PostgREST request against the
// 'snapshots' table (matched by the URL path) with `rows`, and 404s
// anything else so an unexpected query fails loudly instead of hanging.
function makeFetchStub(rows) {
  return async (url) => {
    const href = typeof url === 'string' ? url : url.toString();
    if (href.includes('/rest/v1/snapshots')) {
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  };
}

async function importDbWithStubs({ fetchImpl, ImageImpl }) {
  const originalFetch = globalThis.fetch;
  const originalImage = globalThis.Image;
  globalThis.fetch = fetchImpl;
  if (ImageImpl) globalThis.Image = ImageImpl;
  // Bust the module cache per-test so each test's fetch/Image stub is the
  // one in effect when supabase.js's module-scope client gets constructed
  // and when db.js's functions run.
  const mod = await import(`../src/lib/db.js?t=${Math.random()}`);
  return {
    ...mod,
    restore: () => {
      globalThis.fetch = originalFetch;
      if (ImageImpl) globalThis.Image = originalImage;
    },
  };
}

test('resolveCameraSnapshot: fresh DB snapshot resolves directly, no tunnel fallback needed', async () => {
  const capturedAt = new Date().toISOString(); // just captured — well within maxAgeSec
  const fetchImpl = makeFetchStub([
    { storage_url: 'https://cdn.example/snap-fixture-1.jpg', url: null, captured_at: capturedAt, raw_detections: null },
  ]);
  const { resolveCameraSnapshot, restore } = await importDbWithStubs({ fetchImpl });
  try {
    const result = await resolveCameraSnapshot(CAMERA_ID, 'https://tunnel.example/frame.jpg');
    assert.ok(result, 'expected a resolved snapshot');
    assert.ok(result.url.startsWith('https://cdn.example/snap-fixture-1.jpg'), `expected DB snapshot URL, got ${result.url}`);
    assert.equal(result.capturedAt, capturedAt);
  } finally {
    restore();
  }
});

test('resolveCameraSnapshot: stale/missing DB snapshot falls back to the tunnel URL', async () => {
  // No rows at all — puller down, nothing in the DB for this camera.
  const fetchImpl = makeFetchStub([]);
  const ImageImpl = makeImageStub({ succeed: true });
  const { resolveCameraSnapshot, restore } = await importDbWithStubs({ fetchImpl, ImageImpl });
  try {
    const result = await resolveCameraSnapshot(CAMERA_ID, 'https://tunnel.example/frame.jpg');
    assert.ok(result, 'expected the tunnel fallback to resolve a snapshot URL');
    assert.ok(result.url.startsWith('https://tunnel.example/frame.jpg'), `expected tunnel URL, got ${result.url}`);
    assert.equal(result.snap, null, 'tunnel fallback has no DB snapshot row');
  } finally {
    restore();
  }
});

test('resolveCameraSnapshot: DB snapshot too old to trust falls back to the tunnel URL', async () => {
  const staleCapturedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes old
  const fetchImpl = makeFetchStub([
    { storage_url: 'https://cdn.example/stale.jpg', url: null, captured_at: staleCapturedAt, raw_detections: null },
  ]);
  const ImageImpl = makeImageStub({ succeed: true });
  const { resolveCameraSnapshot, restore } = await importDbWithStubs({ fetchImpl, ImageImpl });
  try {
    const result = await resolveCameraSnapshot(CAMERA_ID, 'https://tunnel.example/frame.jpg', /* maxAgeSec */ 120);
    assert.ok(result, 'expected the tunnel fallback to resolve a snapshot URL');
    assert.ok(result.url.startsWith('https://tunnel.example/frame.jpg'), `expected tunnel URL, got ${result.url}`);
  } finally {
    restore();
  }
});

test('resolveCameraSnapshot: no DB snapshot and no working tunnel URL resolves null', async () => {
  const fetchImpl = makeFetchStub([]);
  const ImageImpl = makeImageStub({ succeed: false });
  const { resolveCameraSnapshot, restore } = await importDbWithStubs({ fetchImpl, ImageImpl });
  try {
    const result = await resolveCameraSnapshot(CAMERA_ID, 'https://tunnel.example/frame.jpg');
    assert.equal(result, null);
  } finally {
    restore();
  }
});

test('resolveCameraSnapshot: no tunnel URL and no DB snapshot resolves null without touching Image', async () => {
  const fetchImpl = makeFetchStub([]);
  const { resolveCameraSnapshot, restore } = await importDbWithStubs({ fetchImpl });
  try {
    const result = await resolveCameraSnapshot(CAMERA_ID, null);
    assert.equal(result, null);
  } finally {
    restore();
  }
});

test('tryLoadImageUrl: resolves true when the image loads with real width', async () => {
  const ImageImpl = makeImageStub({ succeed: true, naturalWidth: 640 });
  const { tryLoadImageUrl, restore } = await importDbWithStubs({ fetchImpl: makeFetchStub([]), ImageImpl });
  try {
    assert.equal(await tryLoadImageUrl('https://tunnel.example/frame.jpg'), true);
  } finally {
    restore();
  }
});

test('tryLoadImageUrl: resolves false on load error', async () => {
  const ImageImpl = makeImageStub({ succeed: false });
  const { tryLoadImageUrl, restore } = await importDbWithStubs({ fetchImpl: makeFetchStub([]), ImageImpl });
  try {
    assert.equal(await tryLoadImageUrl('https://tunnel.example/broken.jpg'), false);
  } finally {
    restore();
  }
});
