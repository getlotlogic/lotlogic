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
