import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ---------------------------------------------------------------------------
// isPlateHeld (holds.ts)
// ---------------------------------------------------------------------------

import { isPlateHeld } from "./holds.ts";

Deno.test("isPlateHeld: returns true when hold_until is in the future", async () => {
  const now = new Date("2026-04-20T12:00:00Z");
  const db = {
    from(table: string) {
      if (table !== "plate_holds") throw new Error(`unexpected table: ${table}`);
      const rows = [
        { id: "h1", property_id: "p1", normalized_plate: "ABC123", hold_until: "2026-04-21T00:00:00Z" },
      ];
      const builder: any = {
        _rows: rows,
        select() { return builder; },
        eq(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => r[c] === v); return builder; },
        gt(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => new Date(r[c]) > new Date(v)); return builder; },
        limit(n: number) {
          return Promise.resolve({ data: builder._rows.slice(0, n), error: null });
        },
      };
      return builder;
    },
  } as any;
  const r = await isPlateHeld(db, "p1", "ABC123", now);
  assertEquals(r, true);
});

Deno.test("isPlateHeld: returns false when hold_until has passed", async () => {
  const now = new Date("2026-04-22T00:00:00Z");
  const db = {
    from(_table: string) {
      const rows = [
        { id: "h1", property_id: "p1", normalized_plate: "ABC123", hold_until: "2026-04-21T00:00:00Z" },
      ];
      const builder: any = {
        _rows: rows,
        select() { return builder; },
        eq(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => r[c] === v); return builder; },
        gt(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => new Date(r[c]) > new Date(v)); return builder; },
        limit(n: number) { return Promise.resolve({ data: builder._rows.slice(0, n), error: null }); },
      };
      return builder;
    },
  } as any;
  const r = await isPlateHeld(db, "p1", "ABC123", now);
  assertEquals(r, false);
});

Deno.test("isPlateHeld: returns false when no rows match", async () => {
  const now = new Date("2026-04-20T12:00:00Z");
  const db = {
    from(_table: string) {
      const builder: any = {
        _rows: [] as any[],
        select() { return builder; },
        eq() { return builder; },
        gt() { return builder; },
        limit() { return Promise.resolve({ data: [], error: null }); },
      };
      return builder;
    },
  } as any;
  const r = await isPlateHeld(db, "p1", "ABC123", now);
  assertEquals(r, false);
});

// ---------------------------------------------------------------------------
// sessions.ts entry-path helpers
// ---------------------------------------------------------------------------

import { findOpenSession, findActiveResident, findActiveVisitorPass } from "./sessions.ts";

Deno.test("findOpenSession returns the row when exited_at IS NULL", async () => {
  const db = {
    from(table: string) {
      const rows = table === "plate_sessions" ? [
        { id: "s1", property_id: "p1", normalized_plate: "ABC123", plate_text: "ABC123", state: "grace", entered_at: "2026-04-20T12:00:00Z", exited_at: null, visitor_pass_id: null, resident_plate_id: null, violation_id: null },
      ] : [];
      const builder: any = {
        _rows: rows,
        select() { return builder; },
        eq(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => r[c] === v); return builder; },
        is(c: string, _v: any) { builder._rows = builder._rows.filter((r: any) => r[c] === null); return builder; },
        limit(n: number) { return Promise.resolve({ data: builder._rows.slice(0, n), error: null }); },
      };
      return builder;
    },
  } as any;
  const s = await findOpenSession(db, "p1", "ABC123");
  assertEquals(s?.id, "s1");
});

Deno.test("findOpenSession returns null when no open session", async () => {
  const db = {
    from(_table: string) {
      const builder: any = {
        _rows: [],
        select() { return builder; },
        eq() { return builder; },
        is() { return builder; },
        limit() { return Promise.resolve({ data: [], error: null }); },
      };
      return builder;
    },
  } as any;
  const s = await findOpenSession(db, "p1", "ABC123");
  assertEquals(s, null);
});

Deno.test("findActiveResident matches with normalization", async () => {
  const db = {
    from(_t: string) {
      const builder: any = {
        _rows: [{ id: "r1", plate_text: "abc-123", active: true, property_id: "p1" }],
        select() { return builder; },
        eq(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => r[c] === v); return builder; },
        limit() { return Promise.resolve({ data: builder._rows, error: null }); },
      };
      return builder;
    },
  } as any;
  const r = await findActiveResident(db, "p1", "ABC123");
  assertEquals(r?.id, "r1");
});

Deno.test("findActiveVisitorPass respects cancelled_at, valid_from, valid_until", async () => {
  const now = new Date("2026-04-20T12:00:00Z");
  const db = {
    from(_t: string) {
      const builder: any = {
        _rows: [
          { id: "v-cancelled", plate_text: "ABC123", valid_from: null, valid_until: "2026-04-21T00:00:00Z", cancelled_at: "2026-04-20T10:00:00Z", property_id: "p1" },
          { id: "v-future",    plate_text: "ABC123", valid_from: "2026-04-21T00:00:00Z", valid_until: "2026-04-22T00:00:00Z", cancelled_at: null, property_id: "p1" },
          { id: "v-expired",   plate_text: "ABC123", valid_from: null, valid_until: "2026-04-20T11:00:00Z", cancelled_at: null, property_id: "p1" },
          { id: "v-good",      plate_text: "abc123", valid_from: "2026-04-20T10:00:00Z", valid_until: "2026-04-21T00:00:00Z", cancelled_at: null, property_id: "p1" },
        ],
        select() { return builder; },
        eq() { return builder; },
        limit() { return Promise.resolve({ data: builder._rows, error: null }); },
      };
      return builder;
    },
  } as any;
  const r = await findActiveVisitorPass(db, "p1", "ABC123", now);
  assertEquals(r?.id, "v-good");
});
