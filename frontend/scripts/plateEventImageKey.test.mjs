// Gate: every camera-snapshot insert that stores a photograph must write the
// R2 object KEY alongside the public URL.
//
// Wave 2.5 Task 10 added plate_events.image_key and a presign endpoint that
// prefers it. The endpoint still works with the column empty — it strips
// settings.r2_public_url off image_url — so nothing visibly breaks if the
// writer is missing. That is exactly why this needs a test: without a writer,
// image_key is NULL for every row written after Task 13 Part C's backfill, the
// backfill can never make the column authoritative, and image_url can never be
// retired. The column would ship dead and no runtime assertion would notice.
//
// camera-snapshot is a Deno edge function with no test harness of its own, so
// this is a source assertion rather than an execution test. It reads the real
// file and checks each `image_url:` field in a plate_events insert body.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FN = path.resolve(
  import.meta.dirname,
  '../../supabase/functions/camera-snapshot/index.ts',
);

const lines = fs.readFileSync(FN, 'utf8').split('\n');

// Collect every object-literal field `image_url: <expr>,` that is not inside a
// comment. Records the field's value and the line that follows it.
function imageUrlFields() {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*image_url:\s*(.+?),\s*$/.exec(lines[i]);
    if (!m) continue;
    if (/^\s*(\/\/|\*)/.test(lines[i])) continue;
    out.push({ lineNo: i + 1, value: m[1].trim(), next: (lines[i + 1] ?? '').trim() });
  }
  return out;
}

test('camera-snapshot writes image_key beside every non-null image_url', () => {
  const fields = imageUrlFields();
  assert.ok(fields.length > 0, `no image_url fields found in ${FN}`);

  const withPhoto = fields.filter(f => f.value !== 'null');
  const withoutPhoto = fields.filter(f => f.value === 'null');

  assert.ok(
    withPhoto.length > 0,
    'expected at least one insert that stores a photograph',
  );

  for (const f of withPhoto) {
    assert.match(
      f.next,
      /^image_key:/,
      `index.ts:${f.lineNo} sets image_url: ${f.value} but the next field is ` +
      `"${f.next}", not image_key. A read written without image_key is ` +
      `invisible to Task 13 Part C's backfill and keeps image_url alive forever.`,
    );
  }

  // The explicit-null sites are diagnostic rows that never upload a frame.
  // They need no image_key: the column defaults to NULL and there is no key.
  for (const f of withoutPhoto) {
    assert.doesNotMatch(
      f.next,
      /^image_key:\s*[^n]/,
      `index.ts:${f.lineNo} sets image_url: null but claims a non-null image_key`,
    );
  }
});

test('image_key is null whenever the R2 upload failed', () => {
  // imageUrl is only assigned from upRes.url when upRes.ok, so a failed upload
  // must not record a key for an object that was never written.
  const keys = lines
    .map((l, i) => ({ lineNo: i + 1, m: /^\s*image_key:\s*(.+?),\s*$/.exec(l) }))
    .filter(x => x.m)
    .map(x => ({ lineNo: x.lineNo, value: x.m[1].trim() }));

  assert.ok(keys.length > 0, 'no image_key field found — the dual-write is missing');

  for (const k of keys) {
    assert.equal(
      k.value,
      'upRes.ok ? key : null',
      `index.ts:${k.lineNo} writes image_key as "${k.value}"; it must be ` +
      `guarded on the upload succeeding, or a key is stored for an object ` +
      `that does not exist in R2.`,
    );
  }
});

test('the deploy-order hazard is documented in the file', () => {
  // PostgREST rejects an insert naming a column missing from its schema cache,
  // so shipping this function before migration 20260914143648 reaches
  // production fails EVERY ingest. The note is the only thing standing between
  // a routine `supabase functions deploy` and a full pipeline outage.
  const src = lines.join('\n');
  assert.match(src, /DEPLOY ORDER/);
  assert.match(src, /20260914143648_plate_events_image_key\.sql/);
});
