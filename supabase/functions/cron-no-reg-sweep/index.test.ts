import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sweepViolations } from "./index.ts";

function makeDb(state: {
  violations: any[];
  passes: any[];
  updates: any[];
}) {
  return {
    from(table: string) {
      let working: any[];
      if (table === "no_registration_violations") working = state.violations;
      else if (table === "visitor_passes") working = state.passes;
      else throw new Error(`unexpected table: ${table}`);

      let filtered = [...working];
      const builder: any = {
        select() { return builder; },
        eq(c: string, v: any) { filtered = filtered.filter(r => r[c] === v); return builder; },
        in(c: string, vs: any[]) { filtered = filtered.filter(r => vs.includes(r[c])); return builder; },
        gt(c: string, v: any) { filtered = filtered.filter(r => new Date(r[c]) > new Date(v)); return builder; },
        gte(c: string, v: any) { filtered = filtered.filter(r => new Date(r[c]) >= new Date(v)); return builder; },
        lt(c: string, v: any) { filtered = filtered.filter(r => new Date(r[c]) < new Date(v)); return builder; },
        lte(c: string, v: any) { filtered = filtered.filter(r => new Date(r[c]) <= new Date(v)); return builder; },
        ilike() { return builder; },
        order() { return builder; },
        limit(n: number) {
          return Promise.resolve({ data: filtered.slice(0, n), error: null });
        },
        update(patch: any) {
          return {
            eq(c1: string, v1: any) {
              const next = {
                eq(c2: string, v2: any) {
                  const targets = working.filter(r => r[c1] === v1 && r[c2] === v2);
                  for (const t of targets) Object.assign(t, patch);
                  state.updates.push({ table, patch, matched: targets.length });
                  return Promise.resolve({ data: null, error: null });
                },
              };
              return next;
            },
          };
        },
      };
      builder.then = (resolve: any) => resolve({ data: filtered, error: null });
      return builder;
    },
  };
}

Deno.test("sweepViolations: pending past grace with no pass → flagged", async () => {
  const state = {
    violations: [{
      id: "v1", property_id: "p1", normalized_plate: "ABC123",
      status: "pending",
      first_seen_at: "2026-05-14T08:00:00Z",
      last_seen_at:  "2026-05-14T08:00:12Z",
      flagged_at: null as string | null,
    }],
    passes: [],
    updates: [] as any[],
  };
  const now = new Date("2026-05-14T08:16:00Z");
  const out = await sweepViolations(makeDb(state) as any, now);
  assertEquals(out.flagged, 1);
  assertEquals(state.violations[0].status, "flagged");
  assertEquals(state.violations[0].flagged_at, now.toISOString());
});

Deno.test("sweepViolations: pending past grace WITH matching pass → resolved_pre_flag", async () => {
  const state = {
    violations: [{
      id: "v1", property_id: "p1", normalized_plate: "ABC123",
      status: "pending",
      first_seen_at: "2026-05-14T08:00:00Z",
      last_seen_at:  "2026-05-14T08:00:12Z",
      flagged_at: null as string | null,
    }],
    passes: [{
      id: "pass1", property_id: "p1", plate_text: "ABC-123", normalized_back_plate: null,
      created_at: "2026-05-14T08:05:00Z",
    }],
    updates: [] as any[],
  };
  const now = new Date("2026-05-14T08:16:00Z");
  const out = await sweepViolations(makeDb(state) as any, now);
  assertEquals(out.resolved_pre_flag, 1);
  assertEquals(state.violations[0].status, "resolved_pre_flag");
});

Deno.test("sweepViolations: flagged + new pass arrives → resolved_late", async () => {
  const state = {
    violations: [{
      id: "v1", property_id: "p1", normalized_plate: "ABC123",
      status: "flagged",
      flagged_at:     "2026-05-14T08:20:00Z",
      first_seen_at:  "2026-05-14T08:00:00Z",
      last_seen_at:   "2026-05-14T08:00:12Z",
    }],
    passes: [{
      id: "pass1", property_id: "p1", plate_text: "ABC-123", normalized_back_plate: null,
      created_at: "2026-05-14T08:30:00Z",
    }],
    updates: [] as any[],
  };
  const now = new Date("2026-05-14T08:35:00Z");
  const out = await sweepViolations(makeDb(state) as any, now);
  assertEquals(out.resolved_late, 1);
  assertEquals(state.violations[0].status, "resolved_late");
});

Deno.test("sweepViolations: pending still in grace is left alone", async () => {
  const state = {
    violations: [{
      id: "v1", property_id: "p1", normalized_plate: "ABC123",
      status: "pending",
      first_seen_at: "2026-05-14T08:00:00Z",
      last_seen_at:  "2026-05-14T08:00:12Z",
      flagged_at: null as string | null,
    }],
    passes: [],
    updates: [] as any[],
  };
  const now = new Date("2026-05-14T08:10:00Z");
  const out = await sweepViolations(makeDb(state) as any, now);
  assertEquals(out.flagged, 0);
  assertEquals(out.resolved_pre_flag, 0);
  assertEquals(state.violations[0].status, "pending");
});
