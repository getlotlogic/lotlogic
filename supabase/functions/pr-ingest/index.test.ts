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
