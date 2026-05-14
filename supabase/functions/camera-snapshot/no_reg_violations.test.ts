import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { bundleEvidence } from "./no_reg_violations.ts";

Deno.test("module loads and exports are wired", () => {
  assertEquals(typeof bundleEvidence, "function");
});

Deno.test("bundleEvidence: maps weak_plate_reads rows to evidence items", () => {
  const rows = [
    { id: "r1", image_url: "https://r2/a.jpg", seen_at: "2026-05-14T08:14:03Z", confidence: 0.78, camera_id: "cam_s1" },
    { id: "r2", image_url: "https://r2/b.jpg", seen_at: "2026-05-14T08:14:07Z", confidence: 0.94, camera_id: "cam_s1", source: "pr_cloud" as const },
  ];
  const out = bundleEvidence(rows);
  assertEquals(out.length, 2);
  assertEquals(out[0], { url: "https://r2/a.jpg", taken_at: "2026-05-14T08:14:03Z", confidence: 0.78, camera_id: "cam_s1", source: "sidecar" });
  assertEquals(out[1], { url: "https://r2/b.jpg", taken_at: "2026-05-14T08:14:07Z", confidence: 0.94, camera_id: "cam_s1", source: "pr_cloud" });
});

import { findOpenViolation } from "./no_reg_violations.ts";

function stubDb(rows: any[]) {
  return {
    from(table: string) {
      if (table !== "no_registration_violations") throw new Error(`unexpected table: ${table}`);
      const builder: any = {
        _rows: [...rows],
        select() { return builder; },
        eq(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => r[c] === v); return builder; },
        in(c: string, vs: any[]) { builder._rows = builder._rows.filter((r: any) => vs.includes(r[c])); return builder; },
        gt(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => new Date(r[c]) > new Date(v)); return builder; },
        order(_c: string, _o: any) { return builder; },
        limit(n: number) { return Promise.resolve({ data: builder._rows.slice(0, n), error: null }); },
      };
      return builder;
    },
  } as any;
}

Deno.test("findOpenViolation: returns most recent open row within window", async () => {
  // Use Date.now()-relative timestamps to avoid time-drift failures
  const recent = new Date(Date.now() - 30 * 60_000).toISOString();    // 30 min ago
  const older  = new Date(Date.now() - 90 * 60_000).toISOString();    // 90 min ago
  const db = stubDb([
    { id: "v1", property_id: "p1", normalized_plate: "ABC123", status: "flagged",
      last_seen_at: recent },
    { id: "v2", property_id: "p1", normalized_plate: "ABC123", status: "pending",
      last_seen_at: older },
    { id: "v3", property_id: "p1", normalized_plate: "XYZ", status: "flagged",
      last_seen_at: recent },
  ]);
  const r = await findOpenViolation(db, { property_id: "p1", normalized_plate: "ABC123", within_hours: 24 });
  assertEquals(r?.id, "v1");
});

Deno.test("findOpenViolation: returns null when nothing matches", async () => {
  const db = stubDb([]);
  const r = await findOpenViolation(db, { property_id: "p1", normalized_plate: "ABC123", within_hours: 24 });
  assertEquals(r, null);
});

import { insertViolation } from "./no_reg_violations.ts";

function stubInsertDb(captured: { args?: any }) {
  return {
    from(_table: string) {
      const builder: any = {
        insert(row: any) {
          captured.args = row;
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { ...row, id: "new-id" }, error: null }),
            }),
          };
        },
      };
      return builder;
    },
  } as any;
}

Deno.test("insertViolation: inserts with provided fields and returns the row", async () => {
  const captured: any = {};
  const db = stubInsertDb(captured);
  const out = await insertViolation(db, {
    property_id: "p1",
    normalized_plate: "ABC123",
    raw_plate: "ABC-123",
    best_confidence: 0.94,
    first_seen_at: new Date("2026-05-14T08:14:03Z"),
    last_seen_at: new Date("2026-05-14T08:14:18Z"),
    presence_strength: "lingered",
    evidence: [],
    weak_read_ids: ["r1", "r2"],
  });
  assertEquals(out.id, "new-id");
  assertEquals(captured.args.property_id, "p1");
  assertEquals(captured.args.presence_strength, "lingered");
  assertEquals(captured.args.status, "pending");
  assertEquals(captured.args.first_seen_at, "2026-05-14T08:14:03.000Z");
});

import { EVIDENCE_CAP, updateViolation } from "./no_reg_violations.ts";

function stubUpdateDb(currentRow: any, captured: { patch?: any }) {
  return {
    from(_table: string) {
      const builder: any = {
        select() { return builder; },
        eq(_c: string, _v: any) { return builder; },
        single() { return Promise.resolve({ data: currentRow, error: null }); },
        update(patch: any) {
          captured.patch = patch;
          return { eq: () => Promise.resolve({ data: null, error: null }) };
        },
      };
      return builder;
    },
  } as any;
}

Deno.test("updateViolation: appends evidence and caps at EVIDENCE_CAP", async () => {
  const existing = Array.from({ length: EVIDENCE_CAP - 1 }, (_, i) => ({
    url: `https://r2/old-${i}.jpg`, taken_at: "2026-05-14T08:00:00Z",
    confidence: 0.5, camera_id: "cam_s1", source: "sidecar" as const,
  }));
  const currentRow = { id: "v1", evidence: existing, weak_read_ids: [], best_confidence: 0.5,
                       last_seen_at: "2026-05-14T08:00:00Z", presence_strength: "brief", exit_seen_at: null };
  const captured: any = {};
  const db = stubUpdateDb(currentRow, captured);

  const newItems = [
    { url: "https://r2/new-a.jpg", taken_at: "2026-05-14T08:15:00Z", confidence: 0.9, camera_id: "cam_s1", source: "sidecar" as const },
    { url: "https://r2/new-b.jpg", taken_at: "2026-05-14T08:15:02Z", confidence: 0.92, camera_id: "cam_s1", source: "sidecar" as const },
  ];

  await updateViolation(db, "v1", { evidence_append: newItems });

  assertEquals(captured.patch.evidence.length, EVIDENCE_CAP);
  assertEquals(captured.patch.evidence[EVIDENCE_CAP - 1].url, "https://r2/new-b.jpg");
  assertEquals(captured.patch.evidence[0].url, "https://r2/old-1.jpg");
});

Deno.test("updateViolation: sets exit_seen_at when provided", async () => {
  const currentRow = { id: "v1", evidence: [], weak_read_ids: [], best_confidence: 0.5,
                       last_seen_at: "2026-05-14T08:00:00Z", presence_strength: "brief", exit_seen_at: null };
  const captured: any = {};
  const db = stubUpdateDb(currentRow, captured);
  await updateViolation(db, "v1", { exit_seen_at: new Date("2026-05-14T09:00:00Z") });
  assertEquals(captured.patch.exit_seen_at, "2026-05-14T09:00:00.000Z");
});

import { findPassForPlateInWindow } from "./no_reg_violations.ts";

function stubPassDb(rows: any[]) {
  return {
    from(table: string) {
      if (table !== "visitor_passes") throw new Error(`unexpected: ${table}`);
      let _rows = [...rows];
      const builder: any = {
        select() { return builder; },
        eq(c: string, v: any) { _rows = _rows.filter((r: any) => r[c] === v); return builder; },
        gte(c: string, v: any) { _rows = _rows.filter((r: any) => new Date(r[c]) >= new Date(v)); return builder; },
        lte(c: string, v: any) { _rows = _rows.filter((r: any) => new Date(r[c]) <= new Date(v)); return builder; },
        ilike(c: string, pattern: string) {
          const rx = new RegExp("^" + pattern.replaceAll("%", ".*") + "$", "i");
          _rows = _rows.filter((r: any) => rx.test(r[c]));
          return builder;
        },
        order(_c: string, _o: any) { return builder; },
        limit(n: number) { return Promise.resolve({ data: _rows.slice(0, n), error: null }); },
      };
      return builder;
    },
  } as any;
}

Deno.test("findPassForPlateInWindow: exact match in window returns pass", async () => {
  const db = stubPassDb([
    { id: "pass1", property_id: "p1", plate_text: "ABC-123",
      normalized_back_plate: null,
      created_at: "2026-05-14T08:30:00Z" },
  ]);
  const out = await findPassForPlateInWindow(db, {
    property_id: "p1", normalized_plate: "ABC123",
    window_start: new Date("2026-05-14T07:00:00Z"),
    window_end:   new Date("2026-05-14T10:00:00Z"),
  });
  assertEquals(out?.id, "pass1");
});

Deno.test("findPassForPlateInWindow: ignores out-of-window passes", async () => {
  const db = stubPassDb([
    { id: "pass-old", property_id: "p1", plate_text: "ABC-123",
      normalized_back_plate: null,
      created_at: "2026-05-13T08:00:00Z" },
  ]);
  const out = await findPassForPlateInWindow(db, {
    property_id: "p1", normalized_plate: "ABC123",
    window_start: new Date("2026-05-14T07:00:00Z"),
    window_end:   new Date("2026-05-14T10:00:00Z"),
  });
  assertEquals(out, null);
});

Deno.test("findPassForPlateInWindow: fuzzy OCR-confusion match wins (8 vs B)", async () => {
  const db = stubPassDb([
    { id: "pass2", property_id: "p1", plate_text: "ABC1234",
      normalized_back_plate: null,
      created_at: "2026-05-14T08:30:00Z" },
  ]);
  // Camera read "ABCB234" — OCR confused 1 → B, but plateSimilar accepts.
  const out = await findPassForPlateInWindow(db, {
    property_id: "p1", normalized_plate: "ABCB234",
    window_start: new Date("2026-05-14T07:00:00Z"),
    window_end:   new Date("2026-05-14T10:00:00Z"),
  });
  assertEquals(out?.id, "pass2");
});

Deno.test("findPassForPlateInWindow: normalized_back_plate matches when only the back is read", async () => {
  const db = stubPassDb([
    { id: "pass3", property_id: "p1", plate_text: "FRONT123",
      normalized_back_plate: "BACK4567",
      created_at: "2026-05-14T08:30:00Z" },
  ]);
  const out = await findPassForPlateInWindow(db, {
    property_id: "p1", normalized_plate: "BACK4567",
    window_start: new Date("2026-05-14T07:00:00Z"),
    window_end:   new Date("2026-05-14T10:00:00Z"),
  });
  assertEquals(out?.id, "pass3");
});
