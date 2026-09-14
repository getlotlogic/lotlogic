// Walker self-test. Runs on stock Node: `node --test supabase/functions/_ci/`.
//
// These assert against the REAL import graph, not a fixture, on purpose: the
// point of the walker is that it stays true as the graph moves. If a test here
// goes red because someone added or removed an import edge, the fix is to
// update the assertion — and the deploy matrix has already updated itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertGuards, filesFor, slugs, slugsForChanged, slugsForOnly } from "./slugs.mjs";

test("finds every deployable slug and no scaffolding", () => {
  const s = slugs();
  assert.ok(s.includes("camera-snapshot"));
  assert.ok(s.includes("weather-risk-eval"));
  assert.ok(!s.includes("_ci"));
  assert.equal(s.length, new Set(s).size);
});

test("camera-snapshot depends on pr-ingest sources", () => {
  // The edge auto-deploy-camera-snapshot.yml had to encode by hand.
  const files = filesFor("camera-snapshot");
  assert.ok(files.includes("supabase/functions/pr-ingest/r2.ts"));
  assert.ok(files.includes("supabase/functions/pr-ingest/normalize.ts"));
  assert.ok(files.includes("supabase/functions/pr-ingest/types.ts"));
  assert.ok(files.includes("supabase/functions/camera-snapshot/auto-fuzzy-config.json"));
});

test("cron-no-reg-sweep depends on camera-snapshot sources", () => {
  // The edge NO hand-written workflow encoded — cron-no-reg-sweep had no
  // workflow at all, so a change to no_reg_violations.ts left it stale.
  const files = filesFor("cron-no-reg-sweep");
  assert.ok(files.includes("supabase/functions/camera-snapshot/no_reg_violations.ts"));
  assert.ok(files.includes("supabase/functions/camera-snapshot/sessions.ts"));
});

test("cron-sessions-sweep depends on camera-snapshot sources", () => {
  // auto-deploy-cron-sessions-sweep.yml watched only
  // supabase/functions/cron-sessions-sweep/**, so this edge was invisible to it.
  const files = filesFor("cron-sessions-sweep");
  assert.ok(files.includes("supabase/functions/camera-snapshot/weak_plate_reads.ts"));
  assert.ok(files.includes("supabase/functions/camera-snapshot/no_reg_violations.ts"));
});

test("a shared file redeploys every slug that reaches it", () => {
  const hit = slugsForChanged(["supabase/functions/camera-snapshot/no_reg_violations.ts"]);
  assert.deepEqual(hit.sort(),
    ["camera-snapshot", "cron-no-reg-sweep", "cron-sessions-sweep"]);
});

test("an unrelated change deploys nothing", () => {
  assert.deepEqual(slugsForChanged(["frontend/dashboard.html"]), []);
});

test("config.toml redeploys everything", () => {
  assert.deepEqual(slugsForChanged(["supabase/config.toml"]), slugs());
});

test("every slug carries a deno.lock and the guards hold", () => {
  assert.doesNotThrow(assertGuards);
});

test("a changed lockfile redeploys its slug", () => {
  // A dependency bump with no source change still has to reach production.
  assert.deepEqual(slugsForChanged(["supabase/functions/weather-pull/deno.lock"]),
                   ["weather-pull"]);
});

test("a manual `only` list deploys exactly those slugs, in canonical order", () => {
  assert.deepEqual(slugsForOnly(" weather-pull , camera-snapshot "),
                   ["camera-snapshot", "weather-pull"]);
  assert.deepEqual(slugsForOnly("all"), slugs());
});

test("a manual `only` refuses blank and refuses a typo", () => {
  // Blank must not silently mean "everything" (16 unintended deploys) or
  // silently mean "nothing" (a green run that shipped nothing).
  assert.throws(() => slugsForOnly(""), /needs `only`/);
  assert.throws(() => slugsForOnly(undefined), /needs `only`/);
  // A typo'd slug would otherwise make the CLI create a new empty function.
  assert.throws(() => slugsForOnly("camera-snapshto"), /unknown slug/);
});
