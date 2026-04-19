import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizePlate } from "./normalize.ts";

Deno.test("normalizePlate uppercases and strips non-alphanumerics", () => {
  assertEquals(normalizePlate("abc-123"), "ABC123");
  assertEquals(normalizePlate("xyz 789"), "XYZ789");
  assertEquals(normalizePlate("  fm046sc  "), "FM046SC");
  assertEquals(normalizePlate(""), "");
});

import type { PrWebhookPayload, PrResult, Deps } from "./types.ts";

Deno.test("PrWebhookPayload has expected shape (compile-time check)", () => {
  const sample: PrWebhookPayload = {
    hook: { target: "https://x", id: 1, event: "image.done" },
    data: {
      filename: "x.jpg",
      timestamp: "2026-04-19T15:00:00Z",
      camera_id: "trillium-front-gate",
      results: [],
    },
  };
  assertEquals(sample.data.camera_id, "trillium-front-gate");
});

import { matchPlate } from "./match.ts";
import { createClient } from "@supabase/supabase-js";

// Build an in-memory fake of the SupabaseClient.from(...).select(...).eq(...) chain
// that returns a fixed array of rows. This mirrors only the shape we use.
function fakeDb(tables: Record<string, any[]>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const builder: any = {
        _filtered: rows,
        select() { return builder; },
        eq(col: string, val: any) {
          builder._filtered = builder._filtered.filter((r: any) => r[col] === val);
          return builder;
        },
        gte(col: string, val: any) {
          builder._filtered = builder._filtered.filter((r: any) => r[col] >= val);
          return builder;
        },
        lt(col: string, val: any) {
          builder._filtered = builder._filtered.filter((r: any) => r[col] < val);
          return builder;
        },
        limit(n: number) {
          builder._filtered = builder._filtered.slice(0, n);
          return Promise.resolve({ data: builder._filtered, error: null });
        },
      };
      return builder;
    },
  } as any;
}

const PROPERTY = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-04-19T15:00:00Z");

Deno.test("matchPlate returns resident when resident_plates has active row", async () => {
  const db = fakeDb({
    resident_plates: [
      { id: "r1", property_id: PROPERTY, plate_text: "ABC-123", active: true },
    ],
    visitor_passes: [],
    parking_registrations: [],
  });
  const r = await matchPlate(db, PROPERTY, "ABC123", NOW);
  assertEquals(r.kind, "resident");
  if (r.kind === "resident") assertEquals(r.resident_plate_id, "r1");
});

Deno.test("matchPlate returns visitor_pass when active pass exists", async () => {
  const db = fakeDb({
    resident_plates: [],
    visitor_passes: [{
      id: "v1", property_id: PROPERTY, plate_text: "abc 123",
      valid_from: "2026-04-19T14:00:00Z", valid_until: "2026-04-19T20:00:00Z",
      cancelled_at: null,
    }],
    parking_registrations: [],
  });
  const r = await matchPlate(db, PROPERTY, "ABC123", NOW);
  assertEquals(r.kind, "visitor_pass");
});

Deno.test("matchPlate returns unmatched when nothing applies", async () => {
  const db = fakeDb({ resident_plates: [], visitor_passes: [], parking_registrations: [] });
  const r = await matchPlate(db, PROPERTY, "ABC123", NOW);
  assertEquals(r.kind, "unmatched");
});

Deno.test("matchPlate skips cancelled visitor_pass", async () => {
  const db = fakeDb({
    resident_plates: [],
    visitor_passes: [{
      id: "v1", property_id: PROPERTY, plate_text: "ABC123",
      valid_from: "2026-04-19T14:00:00Z", valid_until: "2026-04-19T20:00:00Z",
      cancelled_at: "2026-04-19T14:30:00Z",
    }],
    parking_registrations: [],
  });
  const r = await matchPlate(db, PROPERTY, "ABC123", NOW);
  assertEquals(r.kind, "unmatched");
});

import { makeR2Uploader } from "./r2.ts";

Deno.test("makeR2Uploader returns public URL on 200", async () => {
  const fakeFetch = async (_url: string, _init: RequestInit) =>
    new Response("", { status: 200 });
  const upload = makeR2Uploader({
    accountId: "acct",
    bucket: "parking-snapshots",
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    publicBaseUrl: "https://pub-x.r2.dev",
    fetchImpl: fakeFetch as any,
  });
  const r = await upload("foo/bar.jpg", new Uint8Array([1, 2, 3]));
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.url, "https://pub-x.r2.dev/foo/bar.jpg");
});

Deno.test("makeR2Uploader surfaces error on 4xx", async () => {
  const fakeFetch = async () => new Response("denied", { status: 403 });
  const upload = makeR2Uploader({
    accountId: "acct",
    bucket: "parking-snapshots",
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    publicBaseUrl: "https://pub-x.r2.dev",
    fetchImpl: fakeFetch as any,
  });
  const r = await upload("foo/bar.jpg", new Uint8Array([1]));
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error.includes("403"), true);
});

import { runPipeline } from "./pipeline.ts";

const CAMERA_ROW = {
  id: "cam-uuid-1",
  property_id: PROPERTY,
  api_key: "trillium-front-gate",
  active: true,
};

function makePipelineDb(opts: {
  cameras?: any[];
  residents?: any[];
  passes?: any[];
  regs?: any[];
  recentEvents?: any[];   // for dedup query
  inserts?: { plateEvents: any[]; violations: any[] };
}) {
  const inserts = opts.inserts ?? { plateEvents: [], violations: [] };
  return {
    from(table: string) {
      const rows: any[] =
        table === "alpr_cameras" ? (opts.cameras ?? [])
        : table === "resident_plates" ? (opts.residents ?? [])
        : table === "visitor_passes" ? (opts.passes ?? [])
        : table === "parking_registrations" ? (opts.regs ?? [])
        : table === "plate_events" ? (opts.recentEvents ?? [])
        : [];
      const builder: any = {
        _filtered: rows,
        select() { return builder; },
        eq(c: string, v: any) { builder._filtered = builder._filtered.filter((r: any) => r[c] === v); return builder; },
        gte(c: string, v: any) { builder._filtered = builder._filtered.filter((r: any) => new Date(r[c]) >= new Date(v)); return builder; },
        lt() { return builder; },
        limit(n: number) {
          builder._filtered = builder._filtered.slice(0, n);
          return Promise.resolve({ data: builder._filtered, error: null });
        },
        maybeSingle() {
          return Promise.resolve({ data: builder._filtered[0] ?? null, error: null });
        },
        insert(row: any) {
          if (table === "plate_events") inserts.plateEvents.push(row);
          if (table === "alpr_violations") inserts.violations.push(row);
          return {
            select() {
              return {
                single() {
                  return Promise.resolve({
                    data: { id: `${table}-uuid-${inserts.plateEvents.length + inserts.violations.length}`, ...row },
                    error: null,
                  });
                },
              };
            },
          };
        },
      };
      return builder;
    },
  } as any;
}

async function buildMultipartRequest() {
  const sample = JSON.parse(
    await Deno.readTextFile(new URL("./fixtures/pr-webhook-sample.json", import.meta.url)),
  );
  const jpeg = await Deno.readFile(new URL("./fixtures/tiny.jpg", import.meta.url));
  const fd = new FormData();
  fd.append("json", JSON.stringify(sample));
  fd.append("upload", new Blob([jpeg], { type: "image/jpeg" }), "snap.jpg");
  return new Request("https://x.supabase.co/functions/v1/pr-ingest/SECRET", {
    method: "POST",
    body: fd,
  });
}

Deno.test("happy path: unknown plate creates plate_events + alpr_violations", async () => {
  const inserts = { plateEvents: [] as any[], violations: [] as any[] };
  const r2Calls: Array<{ key: string; bytes: Uint8Array }> = [];
  const deps: Deps = {
    db: makePipelineDb({ cameras: [CAMERA_ROW], inserts }),
    r2: async (key, bytes) => { r2Calls.push({ key, bytes }); return { ok: true, url: `https://pub-x.r2.dev/${key}` }; },
    env: { PR_MIN_SCORE: 0.8, PR_DEDUP_WINDOW_SECONDS: 0 },
    now: () => NOW,
  };
  const req = await buildMultipartRequest();
  const result = await runPipeline(req, deps);
  assertEquals(result.status, 200);
  assertEquals(inserts.plateEvents.length, 1);
  assertEquals(inserts.plateEvents[0].plate_text, "FM046SC");
  assertEquals(inserts.plateEvents[0].normalized_plate, "FM046SC");
  assertEquals(inserts.plateEvents[0].image_url, r2Calls[0] ? `https://pub-x.r2.dev/${r2Calls[0].key}` : null);
  assertEquals(inserts.violations.length, 1);
  assertEquals(inserts.violations[0].plate_text, "FM046SC");
});
