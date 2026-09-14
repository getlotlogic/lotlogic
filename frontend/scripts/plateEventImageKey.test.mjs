// Gate: every camera-snapshot insert that stores a photograph must write the
// R2 object KEY alongside the public URL — in EVERY module of the function,
// not just index.ts.
//
// Wave 2.5 Task 10 added plate_events.image_key and a presign endpoint that
// prefers it. The endpoint still works with the column empty — it strips
// settings.r2_public_url off image_url, so nothing visibly breaks if a writer
// is missing. That is exactly why this needs a test: without a writer,
// image_key is NULL for every row written after Task 13 Part C's backfill, the
// backfill can never make the column authoritative, and image_url can never be
// retired. The column would ship dead and no runtime assertion would notice.
//
// Round 1 scanned index.ts alone and passed while the writers that matter were
// still missing: index.ts's own `_source: camera-snapshot:…` paths produced
// ZERO production rows over 120 days, while truck_plaza_exit.ts (reached from
// index.ts:298 for every property_type='truck_plaza' camera) and its
// weak_plate_reads.ts burst flush produced all 53,446 photo-bearing rows. So
// this reads every module.
//
// camera-snapshot is a Deno edge function with no test harness of its own, so
// this is a source assertion rather than an execution test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FN_DIR = path.resolve(
  import.meta.dirname,
  '../../supabase/functions/camera-snapshot',
);

// Every module of the function. `*.test.ts` is excluded: its fixtures are
// hand-built row literals, not insert bodies, and they carry no R2 object.
const MODULES = fs
  .readdirSync(FN_DIR)
  .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .sort()
  .map(f => ({ name: f, lines: fs.readFileSync(path.join(FN_DIR, f), 'utf8').split('\n') }));

// The guarded shapes an image_key expression is allowed to take. An
// unconditional `key` would record a key for an object R2 never stored, so the
// allowlist is the assertion: each entry names why its guard is sound.
const GUARDED_KEY_FORMS = new Map([
  // index.ts — `imageUrl` is assigned from upRes.url only when upRes.ok, so
  // gating the key on the same flag stores a key exactly when the PUT landed.
  ['upRes.ok ? key : null', 'index.ts'],
  // truck_plaza_exit.ts — args.uploadJpeg returns the public URL or null, so a
  // null imageUrl IS the failed-upload signal and r2Key is the key it used.
  ['imageUrl ? r2Key : null', 'truck_plaza_exit.ts'],
  // weak_plate_reads.ts — carried straight off the weak_plate_reads row that
  // also supplied image_url; both were written together at the guarded site
  // in truck_plaza_exit.ts.
  ['chosenFrame.image_key', 'weak_plate_reads.ts'],
]);

// Collect every object-literal field `image_url: <expr>,`. Records the field's
// value and the line that follows it.
function imageUrlFields(mod) {
  const out = [];
  for (let i = 0; i < mod.lines.length; i++) {
    const m = /^\s*image_url:\s*(.+?),\s*$/.exec(mod.lines[i]);
    if (!m) continue;
    out.push({
      file: mod.name,
      lineNo: i + 1,
      value: m[1].trim(),
      next: (mod.lines[i + 1] ?? '').trim(),
    });
  }
  return out;
}

function imageKeyFields(mod) {
  const out = [];
  for (let i = 0; i < mod.lines.length; i++) {
    const m = /^\s*image_key:\s*(.+?),\s*$/.exec(mod.lines[i]);
    if (!m) continue;
    out.push({ file: mod.name, lineNo: i + 1, value: m[1].trim() });
  }
  return out;
}

const allUrlFields = MODULES.flatMap(imageUrlFields);
const allKeyFields = MODULES.flatMap(imageKeyFields);

test('camera-snapshot writes image_key beside every non-null image_url', () => {
  assert.ok(allUrlFields.length > 0, `no image_url fields found under ${FN_DIR}`);

  const withPhoto = allUrlFields.filter(f => f.value !== 'null');
  const withoutPhoto = allUrlFields.filter(f => f.value === 'null');

  assert.ok(
    withPhoto.length > 0,
    'expected at least one insert that stores a photograph',
  );

  for (const f of withPhoto) {
    assert.match(
      f.next,
      /^image_key:/,
      `${f.file}:${f.lineNo} sets image_url: ${f.value} but the next field is ` +
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
      `${f.file}:${f.lineNo} sets image_url: null but claims a non-null image_key`,
    );
  }
});

test('the truck-plaza path — the one production actually writes — is covered', () => {
  // The blocking finding from round 1: index.ts's own insert sites produced
  // ZERO production rows over 120 days. If this test ever stops seeing a
  // guarded key in these two modules it is back to gating nothing that matters.
  for (const mod of ['truck_plaza_exit.ts', 'weak_plate_reads.ts']) {
    const urls = allUrlFields.filter(f => f.file === mod && f.value !== 'null');
    assert.ok(
      urls.length > 0,
      `${mod} no longer has a photo-bearing insert — has the write moved? ` +
      `Point this test at wherever it went.`,
    );
    for (const f of urls) {
      assert.match(f.next, /^image_key:/, `${mod}:${f.lineNo} writes no image_key`);
    }
  }
});

test('image_key is never recorded for an object R2 did not store', () => {
  assert.ok(allKeyFields.length > 0, 'no image_key field found — the dual-write is missing');

  for (const k of allKeyFields) {
    const owner = GUARDED_KEY_FORMS.get(k.value);
    assert.ok(
      owner !== undefined,
      `${k.file}:${k.lineNo} writes image_key as "${k.value}", which is not one ` +
      `of the guarded forms this gate knows about. Either guard it on the upload ` +
      `succeeding, or add it to GUARDED_KEY_FORMS with the reason its guard is ` +
      `sound — otherwise a key can be stored for an object that does not exist.`,
    );
    assert.equal(
      owner,
      k.file,
      `${k.file}:${k.lineNo} uses "${k.value}", the guarded form belonging to ` +
      `${owner}. Its guard reasons about ${owner}'s locals, not this file's.`,
    );
  }
});

test('image_key is carried off the same row as image_url', () => {
  // A carried-through key must come from the row that supplied the URL —
  // `image_url: chosenFrame.image_url` paired with some other row's image_key
  // would silently sign the wrong photograph.
  for (const f of allUrlFields) {
    const m = /^([A-Za-z_$][\w$]*)\.image_url$/.exec(f.value);
    if (!m) continue;
    assert.equal(
      f.next,
      `image_key: ${m[1]}.image_key,`,
      `${f.file}:${f.lineNo} takes image_url off ${m[1]} but pairs it with ` +
      `"${f.next}" — the key must come off the same row.`,
    );
  }
});

test('the deploy-order hazard is documented in every writing module', () => {
  // PostgREST rejects an insert naming a column missing from its schema cache,
  // so shipping this function before migrations 20260914143648 and
  // 20260914170000 reach production fails EVERY ingest. The note is the only
  // thing standing between a routine `supabase functions deploy` and a full
  // pipeline outage — and the truck-plaza modules are where the outage lands.
  for (const mod of ['index.ts', 'truck_plaza_exit.ts', 'weak_plate_reads.ts']) {
    const src = MODULES.find(m => m.name === mod).lines.join('\n');
    assert.match(src, /DEPLOY ORDER/, `${mod} has no DEPLOY ORDER note`);
    assert.match(src, /20260914143648_plate_events_image_key\.sql/, `${mod}`);
    assert.match(src, /20260914170000_weak_plate_reads_image_key\.sql/, `${mod}`);
  }
});
