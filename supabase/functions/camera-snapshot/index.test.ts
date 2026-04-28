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

Deno.test("findActiveResident matches OCR-confused plate (anchored fuzzy)", async () => {
  // Stored ABC123, OCR reads ABCI23 (1↔I confusion). Should still match.
  const db = {
    from(_t: string) {
      const builder: any = {
        _rows: [{ id: "r1", plate_text: "ABC123", active: true, property_id: "p1" }],
        select() { return builder; },
        eq(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => r[c] === v); return builder; },
        limit() { return Promise.resolve({ data: builder._rows, error: null }); },
      };
      return builder;
    },
  } as any;
  const r = await findActiveResident(db, "p1", "ABCI23");
  assertEquals(r?.id, "r1");
});

Deno.test("findActiveResident does NOT match unrelated plate of same length", async () => {
  // Stored ABC123, sees XYZ789. Anchored mode requires ≤1 non-confusion edit.
  const db = {
    from(_t: string) {
      const builder: any = {
        _rows: [{ id: "r1", plate_text: "ABC123", active: true, property_id: "p1" }],
        select() { return builder; },
        eq(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => r[c] === v); return builder; },
        limit() { return Promise.resolve({ data: builder._rows, error: null }); },
      };
      return builder;
    },
  } as any;
  const r = await findActiveResident(db, "p1", "XYZ789");
  assertEquals(r, null);
});

Deno.test("findActiveResident: clean read of ABC123 picks ABC123 even when ABG123 is co-registered", async () => {
  // C↔G is in the OCR confusion list, so anchored-fuzzy alone could match
  // either row. Two-pass exact-then-fuzzy must lock onto the exact row.
  const db = {
    from(_t: string) {
      const builder: any = {
        _rows: [
          { id: "r-abg", plate_text: "ABG123", active: true, property_id: "p1" },
          { id: "r-abc", plate_text: "ABC123", active: true, property_id: "p1" },
        ],
        select() { return builder; },
        eq(c: string, v: any) { builder._rows = builder._rows.filter((r: any) => r[c] === v); return builder; },
        limit() { return Promise.resolve({ data: builder._rows, error: null }); },
      };
      return builder;
    },
  } as any;
  const r = await findActiveResident(db, "p1", "ABC123");
  assertEquals(r?.id, "r-abc");
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

Deno.test("findActiveVisitorPass matches OCR-confused plate (anchored fuzzy)", async () => {
  // Driver registered ABC123. Camera OCR reads AB0123 (B↔0 confusion).
  // Pre-fix: exact equality → unregistered → false tow alert.
  // Post-fix: anchored fuzzy match → matched → no false alert.
  const now = new Date("2026-04-28T12:00:00Z");
  const db = {
    from(_t: string) {
      const builder: any = {
        _rows: [
          { id: "v-good", plate_text: "ABC123", valid_from: "2026-04-28T10:00:00Z", valid_until: "2026-04-29T00:00:00Z", cancelled_at: null, property_id: "p1" },
        ],
        select() { return builder; },
        eq() { return builder; },
        limit() { return Promise.resolve({ data: builder._rows, error: null }); },
      };
      return builder;
    },
  } as any;
  const r = await findActiveVisitorPass(db, "p1", "AB0123", now);
  assertEquals(r?.id, "v-good");
});

// ---------------------------------------------------------------------------
// sessions.ts exit-path helpers
// ---------------------------------------------------------------------------

import { decideExitOutcome } from "./sessions.ts";

Deno.test("decideExitOutcome: registered + still-valid pass -> closed_early", () => {
  const session = {
    id: "s1", property_id: "p1", normalized_plate: "ABC123", plate_text: "ABC123",
    state: "registered" as const, entered_at: "2026-04-20T12:00:00Z",
    visitor_pass_id: "v1", resident_plate_id: null, violation_id: null,
  };
  const exited = new Date("2026-04-20T13:00:00Z");
  const validUntil = new Date("2026-04-21T12:00:00Z");
  const outcome = decideExitOutcome(session, validUntil, exited, 24);
  assertEquals(outcome.kind, "closed_early");
  if (outcome.kind === "closed_early") {
    assertEquals(outcome.visitorPassId, "v1");
    assertEquals(outcome.holdUntil.toISOString(), "2026-04-21T13:00:00.000Z");
  }
});

Deno.test("decideExitOutcome: expired -> closed_post_violation", () => {
  const session = {
    id: "s1", property_id: "p1", normalized_plate: "ABC123", plate_text: "ABC123",
    state: "expired" as const, entered_at: "2026-04-20T12:00:00Z",
    visitor_pass_id: null, resident_plate_id: null, violation_id: "viol1",
  };
  const outcome = decideExitOutcome(session, null, new Date("2026-04-20T12:20:00Z"), 24);
  assertEquals(outcome.kind, "closed_post_violation");
  if (outcome.kind === "closed_post_violation") {
    assertEquals(outcome.violationId, "viol1");
    assertEquals(outcome.leftBeforeTow, true);
  }
});

Deno.test("decideExitOutcome: grace -> closed_clean", () => {
  const session = {
    id: "s1", property_id: "p1", normalized_plate: "ABC123", plate_text: "ABC123",
    state: "grace" as const, entered_at: "2026-04-20T12:00:00Z",
    visitor_pass_id: null, resident_plate_id: null, violation_id: null,
  };
  const outcome = decideExitOutcome(session, null, new Date("2026-04-20T12:05:00Z"), 24);
  assertEquals(outcome.kind, "closed_clean");
});

Deno.test("decideExitOutcome: resident -> closed_clean", () => {
  const session = {
    id: "s1", property_id: "p1", normalized_plate: "ABC123", plate_text: "ABC123",
    state: "resident" as const, entered_at: "2026-04-20T12:00:00Z",
    visitor_pass_id: null, resident_plate_id: "r1", violation_id: null,
  };
  const outcome = decideExitOutcome(session, null, new Date("2026-04-20T18:00:00Z"), 24);
  assertEquals(outcome.kind, "closed_clean");
});

Deno.test("decideExitOutcome: registered but pass already expired -> closed_clean (no hold)", () => {
  const session = {
    id: "s1", property_id: "p1", normalized_plate: "ABC123", plate_text: "ABC123",
    state: "registered" as const, entered_at: "2026-04-20T12:00:00Z",
    visitor_pass_id: "v1", resident_plate_id: null, violation_id: null,
  };
  const exited = new Date("2026-04-21T01:00:00Z");
  const validUntil = new Date("2026-04-21T00:00:00Z"); // passed
  const outcome = decideExitOutcome(session, validUntil, exited, 24);
  assertEquals(outcome.kind, "closed_clean");
});

// ---------------------------------------------------------------------------
// USDOT OCR fallback (usdot-ocr.ts)
// ---------------------------------------------------------------------------

import { extractUsdot } from "./usdot-ocr.ts";

function mockParkpowFetch(responseBody: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(responseBody), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Helper: wrap one or more { texts, label } entries into the real ParkPow
// response shape: { results: [ { texts: [...], object: { label } } ] }.
function pp(detections: Array<{ texts: Array<{ value: string; score: number }>; label?: string }>) {
  return {
    original_width: 100,
    original_height: 100,
    processing_time: 10,
    timestamp: "2026-04-20T00:00:00Z",
    results: detections.map(d => ({
      texts: d.texts,
      object: {
        score: 0.9,
        label: d.label ?? "",
        value: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 },
      },
    })),
  };
}

Deno.test("extractUsdot: returns DOT number when texts contain USDOT pattern", async () => {
  const r = await extractUsdot(new Uint8Array([1, 2, 3]), {
    token: "tok",
    minScore: 0.7,
    fetchImpl: mockParkpowFetch(pp([
      { label: "USDOT", texts: [{ value: "US DOT 1234567", score: 0.89 }] },
    ])),
  });
  assertEquals(r.kind, "dot");
  if (r.kind === "dot") {
    assertEquals(r.number, "1234567");
    assertEquals(r.plate, "DOT-1234567");
  }
});

Deno.test("extractUsdot: accepts USDOT variant with hash", async () => {
  const r = await extractUsdot(new Uint8Array([1]), {
    token: "tok",
    minScore: 0.7,
    fetchImpl: mockParkpowFetch(pp([
      { texts: [{ value: "USDOT #987654", score: 0.85 }] },
    ])),
  });
  assertEquals(r.kind, "dot");
  if (r.kind === "dot") assertEquals(r.number, "987654");
});

Deno.test("extractUsdot: falls back to MC when no DOT present", async () => {
  const r = await extractUsdot(new Uint8Array([1]), {
    token: "tok",
    minScore: 0.7,
    fetchImpl: mockParkpowFetch(pp([
      { texts: [{ value: "ACME TRUCKING INC", score: 0.95 }] },
      { texts: [{ value: "MC 555111", score: 0.82 }] },
    ])),
  });
  assertEquals(r.kind, "mc");
  if (r.kind === "mc") {
    assertEquals(r.number, "555111");
    assertEquals(r.plate, "MC-555111");
  }
});

Deno.test("extractUsdot: drops below-threshold scores", async () => {
  const r = await extractUsdot(new Uint8Array([1]), {
    token: "tok",
    minScore: 0.9,
    fetchImpl: mockParkpowFetch(pp([
      { texts: [{ value: "US DOT 1234567", score: 0.85 }] },  // below threshold
    ])),
  });
  assertEquals(r.kind, "none");
});

Deno.test("extractUsdot: returns none when results is empty", async () => {
  const r = await extractUsdot(new Uint8Array([1]), {
    token: "tok",
    minScore: 0.7,
    fetchImpl: mockParkpowFetch({ results: [], original_width: 0, original_height: 0, processing_time: 1, timestamp: "" }),
  });
  assertEquals(r.kind, "none");
});

Deno.test("extractUsdot: returns none on non-2xx", async () => {
  const r = await extractUsdot(new Uint8Array([1]), {
    token: "tok",
    minScore: 0.7,
    fetchImpl: mockParkpowFetch({ error: "auth" }, 401),
  });
  assertEquals(r.kind, "none");
});

Deno.test("extractUsdot: ignores unrelated numbers", async () => {
  const r = await extractUsdot(new Uint8Array([1]), {
    token: "tok",
    minScore: 0.7,
    fetchImpl: mockParkpowFetch(pp([
      { texts: [{ value: "TRUCK #42", score: 0.99 }] },
      { texts: [{ value: "CAB 5", score: 0.99 }] },
      { texts: [{ value: "PHONE 1-800-555-0000", score: 0.95 }] },
    ])),
  });
  assertEquals(r.kind, "none");
});

Deno.test("extractUsdot: prefers DOT over MC when both present", async () => {
  const r = await extractUsdot(new Uint8Array([1]), {
    token: "tok",
    minScore: 0.7,
    fetchImpl: mockParkpowFetch(pp([
      { texts: [{ value: "MC 888888", score: 0.85 }] },
      { texts: [{ value: "US DOT 777777", score: 0.90 }] },
    ])),
  });
  assertEquals(r.kind, "dot");
  if (r.kind === "dot") assertEquals(r.number, "777777");
});

Deno.test("extractUsdot: digits-only with USDOT label is synthesized as DOT", async () => {
  // The ParkPow model sometimes labels a detection "USDOT" and returns the
  // number as pure digits in texts[0].value. Third-pass fallback should catch it.
  const r = await extractUsdot(new Uint8Array([1]), {
    token: "tok",
    minScore: 0.7,
    fetchImpl: mockParkpowFetch(pp([
      { label: "USDOT", texts: [{ value: "2179839", score: 0.95 }] },
    ])),
  });
  assertEquals(r.kind, "dot");
  if (r.kind === "dot") assertEquals(r.number, "2179839");
});

// ---------------------------------------------------------------------------
// plateSimilar (sessions.ts)
// ---------------------------------------------------------------------------

import { plateSimilar } from "./sessions.ts";

// --- ANCHORED MODE (existing-session match — must NOT cross vehicles) ----

Deno.test("plateSimilar anchored: identical plates match", () => {
  assertEquals(plateSimilar("ABC1234", "ABC1234", true), true);
});

Deno.test("plateSimilar anchored: OCR confusion pair matches (8↔B)", () => {
  assertEquals(plateSimilar("ABC1234", "ABCB234", true), true);
});

Deno.test("plateSimilar anchored: OCR confusion pair matches (C↔G — Charlotte)", () => {
  assertEquals(plateSimilar("CHL1234", "GHL1234", true), true);
});

Deno.test("plateSimilar anchored: M↔N at multiple positions still matches (both are confusions)", () => {
  // Both positions sit within the M↔N confusion pair, counted as zero
  // true edits. Documents the table's behavior — if M↔N is removed,
  // this would need to flip to false.
  assertEquals(plateSimilar("AMN1234", "ANM1234", true), true);
});

Deno.test("plateSimilar anchored: single non-confusion edit matches", () => {
  // P↔R is in confusion table now; pick a non-confusion: A↔X
  assertEquals(plateSimilar("ABC1234", "XBC1234", true), true);
});

Deno.test("plateSimilar anchored: TWO non-confusion edits do NOT match", () => {
  assertEquals(plateSimilar("ABC1234", "XBC1Y34", true), false);
});

Deno.test("plateSimilar anchored: different lengths do NOT match (the HD4183 vs VHD4188 case)", () => {
  // PR #113 regression test: this combo previously triggered a false
  // cross-vehicle session collision.
  assertEquals(plateSimilar("HD4183", "VHD4188", true), false);
});

Deno.test("plateSimilar anchored: substring relation does NOT match (different lengths)", () => {
  assertEquals(plateSimilar("ABC123", "ABC1234", true), false);
});

// --- UNANCHORED MODE (new-session match — looser, optimizes burst dedup) -

Deno.test("plateSimilar unanchored: substring with len-diff 1 matches", () => {
  // Common burst case: extra trailing OCR noise. Should collapse onto
  // the same session.
  assertEquals(plateSimilar("ABC1234", "ABC1234Z", false), true);
});

Deno.test("plateSimilar unanchored: substring with len-diff 3 matches", () => {
  assertEquals(plateSimilar("ABC1234", "XYABC1234", false), true);
});

Deno.test("plateSimilar unanchored: substring with len-diff > 3 does NOT match", () => {
  // ABC1234 (7) vs WXYZABC1234 (11) = diff 4. Substring shortcut requires
  // ≤ 3, so this falls through to levenshtein-≤-1 → fails (4 inserts).
  assertEquals(plateSimilar("ABC1234", "WXYZABC1234", false), false);
});

Deno.test("plateSimilar unanchored: confusion pair on same length matches", () => {
  assertEquals(plateSimilar("LFV2510", "LFV25IO", false), true);
});

Deno.test("plateSimilar unanchored: one-char Levenshtein with len-diff 1 matches", () => {
  // F not in confusion with E currently (E↔F is). Swap with len-diff 1
  // → falls through to levenshteinBounded(1).
  assertEquals(plateSimilar("ABC123", "ABCD123", false), true);
});

Deno.test("plateSimilar unanchored: too-different reads do not match", () => {
  assertEquals(plateSimilar("ABC1234", "XYZ9876", false), false);
});

// --- EDGE CASES ----------------------------------------------------------

Deno.test("plateSimilar: empty strings do not match anything", () => {
  assertEquals(plateSimilar("", "ABC123", true), false);
  assertEquals(plateSimilar("ABC123", "", false), false);
});

// ---------------------------------------------------------------------------
// hammingDistance (image-hash.ts) — sanity for the new dHash burst path
// ---------------------------------------------------------------------------

import { hammingDistance } from "./image-hash.ts";

Deno.test("hammingDistance: identical hashes return 0", () => {
  assertEquals(hammingDistance("00112233aabbccdd", "00112233aabbccdd"), 0);
});

Deno.test("hammingDistance: 1-bit difference returns 1", () => {
  // 0x00 (00000000) vs 0x01 (00000001) = 1 bit differs
  assertEquals(hammingDistance("0000000000000001", "0000000000000000"), 1);
});

Deno.test("hammingDistance: full byte difference returns 8", () => {
  // 0x00 vs 0xff = 8 bits differ in last byte
  assertEquals(hammingDistance("00000000000000ff", "0000000000000000"), 8);
});

Deno.test("hammingDistance: length mismatch returns max", () => {
  assertEquals(hammingDistance("00", "0000"), 64);
});
