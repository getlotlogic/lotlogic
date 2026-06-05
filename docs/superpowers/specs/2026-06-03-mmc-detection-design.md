# (auto-generated from the 14-agent MMC design workflow, 2026-06-03)

> Red-team summary: {"total": 29, "critical_high": 17, "by_lens": [{"lens": "lens-pipeline-safety", "verdict": "The core safety invariant (retry-without-mmc on any non-200) is architecturally sound for the main call site, but there are four concrete blast-radius holes: the bypassSidecarGate path returns \"dropped\" on any null from callPlateRecognizerCloud so the mmc retry must propagate back through the return value or reads are silently dropped; the low-conf PR rescue path (truck_plaza_exit ~501) also calls callP

I have all the structural facts I need. Here is the final implementation design.

---

# LotLogic MMC Detection — Final Implementation Design

## Red-Team Dispositions (before the blueprint)

This section explains each red-team finding and whether it changes the design. Silent omissions are not acceptable; every finding gets a verdict.

**lens-pipeline-safety**

C1 (bypassSidecarGate path drops MMC silently): Valid. `ResolvedPlate` source value is `"pr"` not `"pr_cloud"`. Every reconciliation block in the draft used the wrong string literal. Fixed throughout.

C2 (low-conf PR rescue: soft-threshold variance): Valid as a documentation gap. The retry-without-mmc invariant explicitly covers hard failures (non-200). Soft-threshold variance (mmc=true call returns 200 but confidence 0.38 < PR_RESOLVE_FLOOR) is a separate, low-probability risk. The design cannot retry without mmc on a 200 response without adding call-site logic that the draft does not have and that adds complexity for a speculative risk. Decision: document this as a known limitation in the "decisions & open questions" section. No code change.

H1 (cron-sessions-sweep not updated atomically): Valid. Confirmed in source: `cron-sessions-sweep/index.ts` line 529 calls `flushGroup` with the old shape. It is a separate deployed function. Added to Files to MODIFY and Sprint 1 checklist. `mmcEnabled`/`mmcBackoffMinutes` made optional with defaults in `FlushArgs` so a stale caller degrades gracefully.

H2 (source === "pr" not "pr_cloud"): Valid and critical. Confirmed in source at truck_plaza_exit.ts line 67: `source: "onboard" | "pr"`. All reconciliation blocks updated to use `"pr"`.

M1 (backoff sharing — behavior correct, comment wrong): Valid. The `_mmcUnentitledUntil` variable IS shared across all importers in one isolate (Supabase edge functions reuse warm isolates). The behavior — cross-site suppression within an invocation — is the correct design intent. Only the comment is wrong. Fixed in `mmc.ts`.

M2 (walk-around-ocr is a live broken tool): Valid. Made Sprint 2 a hard gate on Phase 3.

**lens-cost**

C1 (bypassSidecarGate gets mmc=true on every no-plate frame): Valid and important. Confirmed in source: the bypassSidecarGate path at line 415-424 fires PR Cloud on every frame where onboard LPR has no plate. Sending `mmc=true` on frames that may return no plate at all doubles the API call rate on the failure path at the highest-volume call site. Fix: gate `mmcEnabled` on `resolved !== null` at the call site — only enrich frames that already have a plate. This costs zero billing dollars (flat plan) but prevents the pathological retry storm when the plan is not yet entitled.

H1 (isMmcBlocked shared across warm isolates — 60 min suppression on 429): Valid. Draft used `status >= 400 && status < 500`. Fixed: narrow to `status === 402 || status === 403` for entitlement failure. 429 gets a short backoff (5 minutes, separate constant). Other 4xx codes trigger the retry-without-mmc but do NOT call `recordMmcEntitlementFailure`.

H2 (PR_MMC_UNMATCHED_ONLY semantics are property-type, not match-status): Valid. Renamed flag to `PR_MMC_ENFORCEMENT_SITES_ONLY`. The flag gates by property context before the PR call (the only point where gating is possible without a second PR round-trip). The name now matches the implementation.

H3 (frame loop in flushGroup: up to 6 calls on failure path): Valid. Fix: track a `flushMmcEnabled` boolean that is set to false after the first entitlement failure in the frame loop. Subsequent frames in the same flush skip the mmc attempt.

M1 (extractMmc drops vehicle_type when model_make and color absent): Valid. This affects the `alpr_violations.vehicle_type` column specifically. Fix: source `vehicle_type` from the already-extracted `vehicleType` variable (line 926) directly in the `alpr_violations` insert, independent of `mmcData`. Do not route it through `extractMmc`.

**lens-schema**

H1 (vehicle_type on alpr_violations silently NULL): Valid (same as cost M1). Fixed.

H2 (migration 026 absent from repo): Valid. Migration 026 must be created and committed before 027. Added to Sprint 1 as a prerequisite step.

H3 (onboard-vs-PR confidence NULL indistinguishable): Valid design gap. Fix: store `_mmc_source` in `raw_data` (zero migration, no new column needed). Documents source as `"pr_cloud"`, `"onboard_lpr"`, or absent/null when neither fired. Downstream queries can gate on `raw_data->>'_mmc_source'`.

M1 (backoff comment wrong): Same as pipeline-safety M1. Fixed.

M2 (opportunistic flushGroup callers at truck_plaza_exit.ts lines 444 and 473): Valid. Confirmed in source. Both opportunistic flush calls pass hard-coded `FlushArgs` without MMC fields. Both must be patched. Added explicitly to the implementation map.

**lens-ops**

C1 (cron-sessions-sweep not deployed atomically): Same as pipeline H1. Fixed.

C2 (per-invocation backoff is effectively a no-op across invocations): Valid. With warm isolate reuse, `_mmcUnentitledUntil` does persist within a warm isolate's lifetime (minutes to hours), which is better than described. But on a cold start, the state resets. The operational risk — every cold invocation re-probes when the plan is not entitled — is real and bounded. Fix: boot log emits a visible warning when `PR_MMC_ENABLED=true`. Runbook explicitly states that if entitlement retries appear on every read, set `PR_MMC_ENABLED=false` immediately. No DB round-trip added (not worth the complexity).

H1 (walk-around-ocr is a live broken tool, not parallel): Made blocking on Phase 3. Already addressed.

H2 (Phase 0 is advisory not a gate): Valid. Added `PR_MMC_ENTITLEMENT_CONFIRMED` secret as a soft interlock. Boot log warns if `PR_MMC_ENABLED=true` but `PR_MMC_ENTITLEMENT_CONFIRMED` is absent or false.

H3 (observability gap on call sites 2 and 3): Valid and important. Fix: all three call sites' MMC flags are read at the top of `index.ts` and passed explicitly through `TruckPlazaArgs` (for truck_plaza_exit.ts) and `FlushArgs` (for weak_plate_reads.ts/cron). `truck_plaza_exit.ts` and `weak_plate_reads.ts` do NOT read env vars directly — they receive values from the caller. The single boot log line in `index.ts` is authoritative. For the cron path, a boot log line is added to `cron-sessions-sweep/index.ts`.

M1 (Phase 3 rollback propagation latency): Valid. Added ~60s propagation latency note to rollback section.

M2 (4xx entitlement detection too broad): Same as cost H1. Fixed.

**lens-completeness**

H1 (flushGroup callers — index.ts is not actually a caller): Valid. Confirmed in source: `grep` found zero `flushGroup` calls in `index.ts`. The two real opportunistic callers are both inside `truck_plaza_exit.ts` (lines 444 and 473). Corrected throughout.

H2 (alpr_violations CHECK constraint missing 'cooldown'): Valid and critical. Confirmed: migration 010 CHECK is `ARRAY['unregistered','overstay','alpr_unmatched']`. The live code at index.ts line 1293 inserts `violation_type: "cooldown"`. This INSERT is currently failing against the constraint (or Supabase is running in a permissive mode). Migration 027 must repair this constraint as a prerequisite to writing MMC columns to cooldown violations.

M1 (fourth insert path — no_registration_violations): Valid. `insertViolation` in `no_reg_violations.ts` writes to a separate table (`no_registration_violations`, not `alpr_violations`). MMC is most valuable here — the plate may be garbage but the vehicle description is real. Decision: add `vehicle_make`, `vehicle_model`, `vehicle_color` to `no_registration_violations` in migration 027, and thread `prMmcData` through `insertViolation`. This is the highest-operator-value path.

M2 (mmcRequested not in ResolvedPlate): Valid. `ResolvedPlate` must include `mmcRequested?: boolean`. Fixed.

M3 (walk-around-ocr fallback response contract): Valid. Added `mmc_attempted` and `mmc_available` fields to the walk-around response schema definition. Sprint 2 hardening must implement this contract.

M4 (USDOT-synthesized rows never receive MMC from the real PR response): Valid. When `usdotSynthesizedPlate === true`, the `result` variable is a synthetic object with no `model_make` or `color` arrays. `extractMmc(result)` returns `undefined`. The original `prResp.data.results[0]` (which DID have MMC data) is not re-examined. Fix: when `usdotSynthesizedPlate === true`, extract MMC from `prResp.data.results?.[0]` rather than from the synthesized result object. If `prResp.data.results` is empty (PR returned nothing and USDOT synthesized), MMC is null — correct behavior.

---

## Patterns & Conventions (Verified Against Source)

- Env flag pattern: `const FOO = (Deno.env.get("FOO") ?? "false").toLowerCase() === "true";` — index.ts line 14 area.
- Boot log: index.ts line 185: `console.log(\`camera-snapshot boot: ...\`)` — single concatenated string, extend it.
- `callPlateRecognizer`: index.ts lines 1432–1477. Currently takes `(imageBytes, cameraId)`, returns `{ok:true, data, source}` or `{ok:false, status, bodyText}`. No timeout factored out — timeout is inline.
- `PrResult` type: index.ts lines 1623–1628. Currently only `plate`, `score`, `vehicle?`, `box?`. MMC fields are not present.
- `vehicleType`: extracted at line 926 from `result.vehicle?.type`. Used in `insertSession` at line 1250. This extraction is independent of MMC and always works on non-synthesized results.
- `baseEventRow` closure: lines 1013–1049. Returns an object literal. The `...result` spread at line 1034 already captures any fields PR returns in the result object (including MMC fields if present in the JSON) into `raw_data`, but does not parse them into named columns.
- `ResolvedPlate` in truck_plaza_exit.ts: line 67. `{ raw: string; normalized: string; confidence: number | null; source: "onboard" | "pr" }`. Source is `"pr"` not `"pr_cloud"`.
- `FlushArgs` in weak_plate_reads.ts: lines 89–99. Currently has `db, propertyId, groupKey, now, prToken, prApiUrl`. No MMC fields.
- `flushGroup` callers: (1) `truck_plaza_exit.ts` line 444 (sidecar_empty path), (2) `truck_plaza_exit.ts` line 473 (SC211 buffer path). (3) `cron-sessions-sweep/index.ts` line 529. There is NO `flushGroup` call in `camera-snapshot/index.ts`.
- `alpr_violations.violation_type` CHECK (migration 010): `ARRAY['unregistered','overstay','alpr_unmatched']`. The value `'cooldown'` inserted at index.ts line 1293 is NOT in this array — pre-existing bug, must be fixed in migration 027.
- `no_registration_violations` is a separate table from `alpr_violations`. `insertViolation` in `no_reg_violations.ts` writes to it. `flushGroup` unmatched path calls `insertViolation` at weak_plate_reads.ts line 453.

---

## Data Model

### Migration 026 (prerequisite — create before 027)

File: `/Users/gabe/lotlogic/migrations/026_evidence_photo_url.sql`

This migration was applied to production out-of-band. It must be committed to the repo before 027 to maintain sequential integrity. Reconstruct from the applied state:

```sql
-- 026_evidence_photo_url.sql
-- Applied out-of-band (2026 audit); committed here for repo sequential integrity.
-- Adds photo evidence fields to alpr_violations for walk-around tow-write path.
ALTER TABLE public.alpr_violations
  ADD COLUMN IF NOT EXISTS evidence_photo_url  TEXT,
  ADD COLUMN IF NOT EXISTS captured_by         TEXT,
  ADD COLUMN IF NOT EXISTS captured_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS plate_text          TEXT;
```

If the actual out-of-band DDL differs, reconcile before committing. The goal is that `supabase db push` from a clean environment produces a schema identical to production.

### Migration 027

File: `/Users/gabe/lotlogic/migrations/027_vehicle_mmc_columns.sql`

```sql
-- 027_vehicle_mmc_columns.sql
-- Three goals:
--   1. Add MMC (make/model/color) as first-class columns across the evidence chain.
--   2. Fix the pre-existing 'cooldown' violation_type constraint gap (index.ts:1293
--      inserts violation_type='cooldown' which is not in the migration 010 CHECK).
--   3. Add MMC to no_registration_violations (the SC211 unmatched path — highest
--      operator value, since the plate may be garbage but the vehicle description is real).
--
-- All column additions are nullable with no default = lock-free metadata-only DDL on PG 15.
-- IF NOT EXISTS = idempotent, safe to re-run.
-- Depends on: 026 already applied.

-- ── plate_events ─────────────────────────────────────────────────────────────
-- Stores top-ranked PR MMC result per read. vehicle_type is NOT added here —
-- it lives on plate_sessions (migration 012) and is session-scoped. The USDOT-
-- synthesized row case is handled at write time by sourcing from prResp.data.results[0].
ALTER TABLE public.plate_events
  ADD COLUMN IF NOT EXISTS vehicle_make             TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_model            TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_make_confidence  REAL,
  ADD COLUMN IF NOT EXISTS vehicle_color            TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_color_confidence REAL;

-- ── plate_sessions ────────────────────────────────────────────────────────────
-- Carries entry-event MMC forward for cron/dispatch joins without a join.
-- vehicle_type already exists (migration 012).
ALTER TABLE public.plate_sessions
  ADD COLUMN IF NOT EXISTS vehicle_make             TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_model            TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_make_confidence  REAL,
  ADD COLUMN IF NOT EXISTS vehicle_color            TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_color_confidence REAL;

-- ── alpr_violations ───────────────────────────────────────────────────────────
-- Denormalized for standalone tow records + walk-around tow-write path.
-- Confidence scores omitted: violations are operator-action records, not sensor
-- readings. Full PR scores remain in plate_events.raw_data for forensics.
-- vehicle_type IS included: violations are standalone records that must carry
-- all four vehicle attributes without a join (walk-around tow-write path).
ALTER TABLE public.alpr_violations
  ADD COLUMN IF NOT EXISTS vehicle_make   TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_model  TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_color  TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_type   TEXT;

-- Fix pre-existing constraint gap: 'cooldown' is inserted at camera-snapshot
-- index.ts:1293 but was not in the migration 010 CHECK array.
ALTER TABLE public.alpr_violations
  DROP CONSTRAINT IF EXISTS alpr_violations_violation_type_ck;
ALTER TABLE public.alpr_violations
  ADD CONSTRAINT alpr_violations_violation_type_ck
  CHECK (violation_type = ANY (ARRAY[
    'unregistered',
    'overstay',
    'alpr_unmatched',
    'cooldown'
  ]));
-- Note: 'walk_around' is intentionally omitted here; it will be added in
-- migration 028 when the tow-write edge function is built (Sprint 6).

-- ── no_registration_violations ───────────────────────────────────────────────
-- SC211 unmatched-plate path. This is the highest-operator-value MMC surface:
-- the plate text may be garbage OCR, but the vehicle make/model/color from PR
-- lets the operator identify the vehicle on lot.
ALTER TABLE public.no_registration_violations
  ADD COLUMN IF NOT EXISTS vehicle_make   TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_model  TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_color  TEXT;

-- No indexes at this stage. Read volume is tens/hour; property_id index covers
-- all current query patterns. Add (property_id, vehicle_make) partial index
-- when a dashboard query explicitly filters by make.
```

---

## Shared MMC Module

Create: `/Users/gabe/lotlogic/supabase/functions/camera-snapshot/mmc.ts`

```typescript
// mmc.ts — shared MMC types, extraction, and entitlement-failure backoff.
//
// IMPORTANT: This module-level variable is shared across ALL importers within
// the same Deno isolate (i.e., within one edge function invocation or across
// multiple requests within a warm isolate's lifetime). This is INTENTIONAL:
// a single entitlement failure suppresses mmc for all subsequent PR calls in
// the same isolate, regardless of which call site triggered the failure.
// Do NOT move this variable into individual call-site files — doing so would
// break the cross-call-site suppression guarantee.

export type PrMmcData = {
  make: string | null;
  model: string | null;
  make_score: number | null;
  color: string | null;
  color_score: number | null;
  vehicle_type: string | null;
  orientation: string | null;
};

let _mmcUnentitledUntil = 0;
let _mmcRateLimitedUntil = 0;

export function isMmcBlocked(): boolean {
  return Date.now() < _mmcUnentitledUntil || Date.now() < _mmcRateLimitedUntil;
}

// Call on HTTP 402 or 403 — indicates plan does not include MMC.
// Suppresses all further mmc attempts for backoffMinutes.
export function recordMmcEntitlementFailure(backoffMinutes: number): void {
  _mmcUnentitledUntil = Date.now() + backoffMinutes * 60_000;
  console.warn(`[mmc] entitlement failure (402/403); suppressing mmc for ${backoffMinutes}m within this isolate`);
}

// Call on HTTP 429 — rate limit, not an entitlement failure.
// Short backoff only; does NOT set the long entitlement gate.
export function recordMmcRateLimit(): void {
  _mmcRateLimitedUntil = Date.now() + 5 * 60_000; // 5-minute backoff
  console.warn("[mmc] rate limited (429); suppressing mmc for 5m within this isolate");
}

// Extracts top-ranked MMC fields from a single PR results[] entry.
// Returns undefined when no MMC data is present (non-mmc plan, or mmc=false call).
// Callers must treat undefined as "MMC not available" rather than an error.
// NOTE: vehicle_type from PR (result.vehicle?.type) is always available
// regardless of MMC plan and is extracted separately at the call site from
// the raw result — do not depend on this function for vehicle_type.
export function extractMmc(result: unknown): PrMmcData | undefined {
  const r = result as Record<string, unknown>;
  const mm = Array.isArray(r.model_make)
    ? (r.model_make[0] as Record<string, unknown> | undefined)
    : undefined;
  const col = Array.isArray(r.color)
    ? (r.color[0] as Record<string, unknown> | undefined)
    : undefined;
  const orient = Array.isArray(r.orientation)
    ? (r.orientation[0] as Record<string, unknown> | undefined)
    : undefined;
  if (!mm && !col) return undefined;
  return {
    make:         (mm?.make  as string | null)  ?? null,
    model:        (mm?.model as string | null)  ?? null,
    make_score:   typeof mm?.score  === "number" ? (mm.score  as number) : null,
    color:        (col?.color as string | null) ?? null,
    color_score:  typeof col?.score === "number" ? (col.score as number) : null,
    vehicle_type: ((r.vehicle as Record<string, unknown>)?.type as string | null) ?? null,
    orientation:  (orient?.orientation as string | null) ?? null,
  };
}

// Columns to spread into a plate_events or plate_sessions insert row.
// vehicle_type is NOT included here — source it from vehicleType (line 926
// in index.ts) rather than from mmcData, because vehicle_type is available
// on every PR call regardless of MMC plan.
export function mmcColumns(mmc: PrMmcData | undefined): {
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_make_confidence: number | null;
  vehicle_color: string | null;
  vehicle_color_confidence: number | null;
} {
  return {
    vehicle_make:             mmc?.make        ?? null,
    vehicle_model:            mmc?.model       ?? null,
    vehicle_make_confidence:  mmc?.make_score  ?? null,
    vehicle_color:            mmc?.color       ?? null,
    vehicle_color_confidence: mmc?.color_score ?? null,
  };
}

// Applies the entitlement-failure or rate-limit backoff based on HTTP status.
// Returns true if a backoff was recorded (caller should log accordingly).
export function handleMmcFailureStatus(status: number, backoffMinutes: number): boolean {
  if (status === 402 || status === 403) {
    recordMmcEntitlementFailure(backoffMinutes);
    return true;
  }
  if (status === 429) {
    recordMmcRateLimit();
    return true;
  }
  return false;
}
```

---

## Code Changes — File by File

### 1. `/Users/gabe/lotlogic/supabase/functions/camera-snapshot/index.ts`

**Env constants (add near line 14, alongside existing block):**

```typescript
const PR_MMC_ENABLED              = (Deno.env.get("PR_MMC_ENABLED")              ?? "false").toLowerCase() === "true";
const PR_MMC_ENTITLEMENT_CONFIRMED = (Deno.env.get("PR_MMC_ENTITLEMENT_CONFIRMED") ?? "false").toLowerCase() === "true";
const PR_MMC_BACKOFF_MINUTES       = Number(Deno.env.get("PR_MMC_BACKOFF_MINUTES") ?? "60");
// When true, only send mmc=true for reads from truck_plaza or enforcement-active
// properties. Renamed from PR_MMC_UNMATCHED_ONLY (which was a misnomer — the
// gate is by property type, not by match outcome, because match status is not
// known until 430 lines after the PR call). Flat plan uplift means this flag
// saves zero billing dollars once the plan is upgraded; it exists purely to
// delay the plan upgrade until tow-enforcement properties are live.
const PR_MMC_ENFORCEMENT_SITES_ONLY = (Deno.env.get("PR_MMC_ENFORCEMENT_SITES_ONLY") ?? "false").toLowerCase() === "true";
```

**Boot log (line 185) — extend the existing console.log string:**

```typescript
console.log(`camera-snapshot boot: ... mmc_enabled=${PR_MMC_ENABLED} mmc_entitlement_confirmed=${PR_MMC_ENTITLEMENT_CONFIRMED} mmc_enforcement_sites_only=${PR_MMC_ENFORCEMENT_SITES_ONLY}`);
```

Add an entitlement interlock warning immediately after:

```typescript
if (PR_MMC_ENABLED && !PR_MMC_ENTITLEMENT_CONFIRMED) {
  console.warn("[mmc] WARNING: PR_MMC_ENABLED=true but PR_MMC_ENTITLEMENT_CONFIRMED is not set. Every invocation will attempt mmc=true and retry on failure. Set PR_MMC_ENTITLEMENT_CONFIRMED=true after confirming PR plan includes MMC.");
}
```

**Import at top of file (after existing imports):**

```typescript
import { extractMmc, mmcColumns, isMmcBlocked, handleMmcFailureStatus, type PrMmcData } from "./mmc.ts";
```

**`PrResult` type (lines 1623–1628) — add MMC fields:**

```typescript
type PrResult = {
  plate: string;
  score: number;
  vehicle?: { score?: number; type?: string | null; box?: unknown };
  box?: unknown;
  model_make?: Array<{ make?: string; model?: string; score?: number }>;
  color?: Array<{ color?: string; score?: number }>;
  orientation?: Array<{ orientation?: string; score?: number }>;
  _synthesized_from?: string;
  _synthesized_raw_text?: string;
};
```

**`callPlateRecognizer` function (lines 1432–1477) — full replacement:**

The function gains `mmcEnabled` and `mmcBackoffMinutes` parameters. Return type gains `mmcRequested: boolean`. The `buildForm` helper is extracted so both the mmc and no-mmc attempts use identical form construction. The retry fires on ANY non-200 from an mmc-enabled request; entitlement failure detection uses only status 402/403.

```typescript
async function callPlateRecognizer(
  imageBytes: Uint8Array,
  cameraId: string,
  mmcEnabled: boolean,
  mmcBackoffMinutes: number,
): Promise<
  | { ok: true; data: unknown; source: "sdk" | "cloud"; mmcRequested: boolean }
  | { ok: false; status: number; bodyText: string }
> {
  const usingSdk = !!PR_SDK_URL;
  if (!usingSdk && !PR_TOKEN) {
    return { ok: false, status: 0, bodyText: "PLATE_RECOGNIZER_TOKEN missing (and PR_SDK_URL unset)" };
  }

  const buildForm = (withMmc: boolean): FormData => {
    const fd = new FormData();
    const buf = imageBytes.buffer.slice(
      imageBytes.byteOffset,
      imageBytes.byteOffset + imageBytes.byteLength,
    ) as ArrayBuffer;
    fd.append("upload", new Blob([buf], { type: "image/jpeg" }), "snap.jpg");
    fd.append("camera_id", cameraId);
    if (withMmc) fd.append("mmc", "true");
    return fd;
  };

  const doFetch = async (fd: FormData): Promise<
    { ok: true; data: unknown } | { ok: false; status: number; bodyText: string }
  > => {
    const url = usingSdk ? PR_SDK_URL : "https://api.platerecognizer.com/v1/plate-reader/";
    const headers: Record<string, string> = usingSdk ? {} : { Authorization: `Token ${PR_TOKEN}` };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(url, { method: "POST", headers, body: fd, signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        return { ok: false, status: res.status, bodyText };
      }
      return { ok: true, data: await res.json() };
    } catch (err) {
      clearTimeout(timer);
      const name = (err as Error)?.name;
      const msg  = (err as Error)?.message ?? "fetch_failed";
      return { ok: false, status: 0, bodyText: name === "AbortError" ? "timeout" : msg };
    }
  };

  // SDK note: if the SDK endpoint does not support mmc=true, it will return a
  // 4xx and the retry-without-mmc fires. This is correct safe behavior.
  // If every SDK read silently degrades, the entitlement warning will appear
  // in logs on 402/403 responses.
  const source: "sdk" | "cloud" = usingSdk ? "sdk" : "cloud";
  const tryMmc = mmcEnabled && !isMmcBlocked();

  if (tryMmc) {
    const first = await doFetch(buildForm(true));
    if (first.ok) return { ...first, source, mmcRequested: true };
    // Non-200 on an mmc-augmented call. Apply status-specific backoff.
    handleMmcFailureStatus(first.status, mmcBackoffMinutes);
    console.warn(
      `[callPlateRecognizer] mmc attempt returned ${first.status}; retrying without mmc (source=${source})`,
    );
    const retry = await doFetch(buildForm(false));
    if (!retry.ok) return retry; // true PR outage — same behavior as today
    return { ...retry, source, mmcRequested: false };
  }

  const attempt = await doFetch(buildForm(false));
  if (!attempt.ok) return attempt;
  return { ...attempt, source, mmcRequested: false };
}
```

**Call site at line 797 — add wantMmc gate:**

```typescript
// Compute whether to request MMC for this read. The gate fires before the PR
// call because match_status is not known until after PR returns. Property-type
// is the available proxy. PR_MMC_ENFORCEMENT_SITES_ONLY=false (default) means
// all reads get mmc=true when the plan is enabled, at zero additional billing cost.
const wantMmc = PR_MMC_ENABLED && (
  !PR_MMC_ENFORCEMENT_SITES_ONLY ||
  property.property_type === "truck_plaza" ||
  (property as Record<string, unknown>).tow_enforcement_active === true
);

const prResp = await callPlateRecognizer(
  bytesForRecognizers,
  cameraApiKey,
  wantMmc,
  PR_MMC_BACKOFF_MINUTES,
);
if (!prResp.ok) {
  console.warn("camera-snapshot PR call failed:", prResp.status, prResp.bodyText.slice(0, 200));
  return json(200, { ok: false, reason: "pr_call_failed", status: prResp.status });
}
```

**After line 926 (vehicleType extraction), add MMC extraction:**

```typescript
const vehicleType = (result as { vehicle?: { type?: string | null } }).vehicle?.type ?? null;

// MMC extraction. When usdotSynthesizedPlate=true, `result` is a synthetic
// object with no model_make/color arrays — extract MMC from the first real
// PR result instead (the one PR actually analyzed before USDOT synthesis).
// If prResp.data.results is empty (PR returned nothing, USDOT synthesized),
// mmcData is undefined — correct.
const mmcSourceResult = usdotSynthesizedPlate
  ? (Array.isArray((prResp.data as Record<string, unknown>)?.results)
      ? (prResp.data as Record<string, unknown[]>).results[0]
      : undefined)
  : result;
const mmcData: PrMmcData | undefined = prResp.mmcRequested
  ? extractMmc(mmcSourceResult)
  : undefined;
```

**`baseEventRow` closure (lines 1013–1049) — add MMC fields:**

Inside the returned object literal, add the five MMC columns and extend `raw_data`:

```typescript
// Five first-class MMC columns (requires migration 027):
...mmcColumns(mmcData),
// Extend raw_data:
raw_data: {
  ...result,
  _pr_response: prResp.data,
  _pr_source: prResp.source,
  _pr_mmc_requested: prResp.mmcRequested,
  _mmc: mmcData ?? null,
  // Documents whether MMC values came from PR cloud or onboard LPR.
  // NULL = neither path fired (flag off or PR returned no MMC data).
  _mmc_source: mmcData ? "pr_cloud" : null,
  _source: `camera-snapshot:${extracted.source}`,
  _orientation: camera.orientation,
  _usdot_ocr: usdotResult.kind === "none"
    ? null
    : { kind: usdotResult.kind, number: usdotResult.number, score: usdotResult.raw_score },
  ...(extracted.rawMeta ?? {}),
  ...(imageError ? { image_upload_error: imageError } : {}),
},
```

**`insertSession` call (lines 1244–1259) — add MMC fields:**

```typescript
sess = await insertSession(db, {
  propertyId: camera.property_id,
  normalizedPlate: normalized,
  plateText: plateUpper,
  backPlate: paired?.paired_plate ?? null,
  normalizedBackPlate: paired?.normalized_paired_plate ?? null,
  vehicleType,
  vehicleMake:           mmcData?.make            ?? null,
  vehicleModel:          mmcData?.model           ?? null,
  vehicleMakeConfidence: mmcData?.make_score      ?? null,
  vehicleColor:          mmcData?.color           ?? null,
  vehicleColorConfidence: mmcData?.color_score    ?? null,
  entryCameraId: camera.id,
  entryPlateEventId: ev.data.id,
  state,
  visitorPassId: pass?.id ?? null,
  residentPlateId: resident?.id ?? null,
  usdotNumber: ...,
  mcNumber: ...,
  enteredAt: now,
});
```

**`alpr_violations` insert for cooldown (lines 1288–1296) — add MMC fields:**

Note: `vehicle_type` is sourced from `vehicleType` (line 926), NOT from `mmcData?.vehicle_type`, because `vehicle_type` is always available from PR regardless of MMC plan.

```typescript
const vIns = await db.from("alpr_violations").insert({
  property_id: camera.property_id,
  plate_event_id: ev.data.id,
  plate_text: plateUpper,
  status: "pending",
  violation_type: "cooldown",
  session_id: sess.id,
  notes: `Re-entry within ${cooldown.cooldown_hours}h cooldown (prior exit ${cooldown.prior_exited_at})`,
  // MMC: vehicle_type always available from PR; make/model/color only when MMC plan active.
  vehicle_type:  vehicleType ?? null,
  vehicle_make:  mmcData?.make  ?? null,
  vehicle_model: mmcData?.model ?? null,
  vehicle_color: mmcData?.color ?? null,
}).select("id").single();
```

**Pass `PR_MMC_ENABLED` and `PR_MMC_BACKOFF_MINUTES` to `handleTruckPlazaExit` via `TruckPlazaArgs`.**

The truck_plaza path reads env vars from the caller (index.ts) rather than from Deno.env directly in truck_plaza_exit.ts. This keeps the boot log authoritative and the module-level env block centralized.

---

### 2. `/Users/gabe/lotlogic/supabase/functions/camera-snapshot/truck_plaza_exit.ts`

**`ResolvedPlate` type (line 67) — add `mmc` and `mmcRequested`:**

```typescript
type ResolvedPlate = {
  raw: string;
  normalized: string;
  confidence: number | null;
  source: "onboard" | "pr";
  mmc?: PrMmcData;
  mmcRequested?: boolean;
};
```

**`handleTruckPlazaExit` args struct — add MMC config fields:**

```typescript
export async function handleTruckPlazaExit(args: {
  // ... existing fields ...
  mmcEnabled?: boolean;
  mmcBackoffMinutes?: number;
}): Promise<TruckPlazaResult>
```

**Import at top of file:**

```typescript
import { extractMmc, isMmcBlocked, handleMmcFailureStatus, type PrMmcData } from "./mmc.ts";
```

**`callPlateRecognizerCloud` function (lines 336–366) — full replacement:**

```typescript
async function callPlateRecognizerCloud(
  token: string,
  apiUrl: string,
  bytes: Uint8Array,
  mmcEnabled = false,
  mmcBackoffMinutes = 60,
): Promise<{ plate: string; confidence: number; mmc?: PrMmcData; mmcRequested: boolean } | null> {
  if (!token) return null;

  const buildForm = (withMmc: boolean): FormData => {
    const form = new FormData();
    form.append("upload", new Blob([bytes as BlobPart], { type: "image/jpeg" }), "snapshot.jpg");
    form.append("regions", "us");
    if (withMmc) form.append("mmc", "true");
    return form;
  };

  const doCall = async (form: FormData): Promise<
    { ok: true; body: unknown } | { ok: false; status: number }
  > => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { Authorization: `Token ${token}` },
        body: form,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, status: res.status };
      return { ok: true, body: await res.json() };
    } catch (err) {
      clearTimeout(timer);
      console.warn(`callPlateRecognizerCloud failed: ${(err as Error)?.message ?? err}`);
      return { ok: false, status: 0 };
    }
  };

  const tryMmc = mmcEnabled && !isMmcBlocked();
  let body: unknown;
  let mmcRequested = false;

  if (tryMmc) {
    const first = await doCall(buildForm(true));
    if (!first.ok) {
      handleMmcFailureStatus(first.status, mmcBackoffMinutes);
      console.warn(`callPlateRecognizerCloud: mmc ${first.status}; retrying without mmc`);
      const retry = await doCall(buildForm(false));
      if (!retry.ok) return null;
      body = retry.body;
      mmcRequested = false;
    } else {
      body = first.body;
      mmcRequested = true;
    }
  } else {
    const attempt = await doCall(buildForm(false));
    if (!attempt.ok) return null;
    body = attempt.body;
  }

  const results = ((body as Record<string, unknown>)?.results ?? []) as Array<Record<string, unknown>>;
  if (results.length === 0) return null;
  const best = results.reduce((a, b) =>
    Number(b.score ?? 0) > Number(a.score ?? 0) ? b : a,
  );
  if (!best.plate || typeof best.score !== "number") return null;
  return {
    plate:        best.plate as string,
    confidence:   best.score as number,
    mmc:          mmcRequested ? extractMmc(best) : undefined,
    mmcRequested,
  };
}
```

**bypassSidecarGate block (line 415–424) — carry `mmc` and `mmcRequested` onto `resolved`:**

The MMC gate for this call is `mmcEnabled && resolved !== null`. Since this block fires only when `resolved` is null (no onboard plate), we do NOT pass mmc to this call — enriching every no-plate probe frame doubles API calls on the entitlement-failure path for no value.

```typescript
if (!resolved && args.bypassSidecarGate) {
  // Do NOT pass mmcEnabled here: this call fires on frames that may return no
  // plate at all (the entire purpose is to check). Sending mmc=true on blank
  // frames doubles the retry cost when the plan isn't entitled. MMC is applied
  // post-match, below (low-conf rescue path) where a plate is confirmed.
  const prResult = await callPlateRecognizerCloud(args.prToken, args.prApiUrl, payload.bytes);
  if (!prResult || !prResult.plate) {
    return { outcome: "dropped", reason: "pr_empty" };
  }
  const prNorm = normalizePlate(prResult.plate);
  if (prNorm.length < 4) {
    return { outcome: "dropped", reason: "pr_plate_too_short" };
  }
  resolved = {
    raw: prResult.plate,
    normalized: prNorm,
    confidence: prResult.confidence,
    source: "pr",
    mmc: undefined,
    mmcRequested: false,
  };
  // Fall through to section 3 (tow truck + pass matching).
}
```

**low-conf rescue block (lines 499–515) — pass MMC, carry result:**

```typescript
if (resolved && resolved.source === "onboard" && resolved.confidence !== null && resolved.confidence < ONBOARD_CONF_FLOOR) {
  lowConfPath = true;
  const prResult = await callPlateRecognizerCloud(
    args.prToken,
    args.prApiUrl,
    payload.bytes,
    args.mmcEnabled ?? false,
    args.mmcBackoffMinutes ?? 60,
  );
  if (prResult && prResult.plate && prResult.confidence >= PR_RESOLVE_FLOOR) {
    const prNorm = normalizePlate(prResult.plate);
    if (prNorm.length >= 4) {
      resolved = {
        raw: prResult.plate,
        normalized: prNorm,
        confidence: prResult.confidence,
        source: "pr",
        mmc: prResult.mmc,
        mmcRequested: prResult.mmcRequested,
      };
    } else {
      return { outcome: "dropped", reason: `low_conf_pr_short_${resolved.confidence.toFixed(2)}` };
    }
  } else {
    return { outcome: "dropped", reason: `low_conf_pr_empty_${resolved.confidence.toFixed(2)}` };
  }
}
```

**Reconciliation at `plate_events` insert (lines 613–640):**

`resolved.source` is `"onboard"` or `"pr"` (confirmed in source, line 67). The draft used `"pr_cloud"` throughout — every occurrence must be `"pr"`.

```typescript
// MMC source reconciliation:
// - source === "pr": PR cloud analyzed this frame and may have returned MMC.
// - source === "onboard": TS4467 firmware. Use onboard vehicleBrand/vehicleColor.
//   No confidence scores available from onboard LPR.
const insertMmc = resolved.source === "pr" ? resolved.mmc : undefined;
const onboard = payload.onboardLpr;

const vehicleMakeInsert  = insertMmc?.make  ?? onboard?.vehicleBrand  ?? null;
const vehicleModelInsert = insertMmc?.model ?? null; // onboard has no model field
const vehicleColorInsert = insertMmc?.color ?? onboard?.vehicleColor  ?? null;
const vehicleMakeConf    = insertMmc ? (insertMmc.make_score  ?? null) : null;
const vehicleColorConf   = insertMmc ? (insertMmc.color_score ?? null) : null;
// vehicle_type: from onboard firmware or PR base detection (always available).
// Onboard delivers via onboard.vehicleType; PR via result.vehicle.type (not
// available here since we don't have the raw PR result object at this scope —
// use onboard for onboard path, and for PR path it will be in mmc?.vehicle_type).
const vehicleTypeInsert  = onboard?.vehicleType ?? insertMmc?.vehicle_type ?? null;

// _mmc_source in raw_data distinguishes PR MMC, onboard LPR, and neither.
const mmcSource = insertMmc
  ? "pr_cloud"
  : (onboard?.vehicleBrand || onboard?.vehicleColor ? "onboard_lpr" : null);

const evIns = await db.from("plate_events").insert({
  property_id: camera.property_id,
  camera_id: camera.id,
  plate_text: resolved.raw.toUpperCase(),
  normalized_plate: resolved.normalized,
  image_url: imageUrl,
  vehicle_make:             vehicleMakeInsert,
  vehicle_model:            vehicleModelInsert,
  vehicle_make_confidence:  vehicleMakeConf,
  vehicle_color:            vehicleColorInsert,
  vehicle_color_confidence: vehicleColorConf,
  raw_data: {
    onboardLpr: onboard,
    flow: tow ? "partner_truck_sighting" : "truck_plaza_exit",
    ocr_source: resolved.source,
    direction: onboard?.direction ?? null,
    pass_id: pass?.id ?? null,
    pass_match_fuzzy: fuzzyHit,
    cross_camera_match: crossCameraUnification,
    verified_pair_match: verifiedPairMatch,
    overstay,
    _pr_mmc_requested: resolved.mmcRequested ?? false,
    _mmc: insertMmc ?? null,
    _mmc_source: mmcSource,
    ...(payload.rawMeta ?? {}),
  },
  match_status: matchStatus,
  confidence: resolved.confidence,
}).select("id").single();
```

**Opportunistic `flushGroup` calls (lines 444 and 473) — add MMC args:**

Both calls must receive `mmcEnabled` and `mmcBackoffMinutes` from `args`:

```typescript
// Line 444 (sidecar_empty path):
const r = await flushGroup({
  db,
  propertyId: s.property_id,
  groupKey: s.group_key,
  now,
  prToken: args.prToken,
  prApiUrl: args.prApiUrl,
  mmcEnabled: args.mmcEnabled,
  mmcBackoffMinutes: args.mmcBackoffMinutes,
});

// Line 473 (SC211 buffer path):
const r = await flushGroup({
  db,
  propertyId: s.property_id,
  groupKey: s.group_key,
  now,
  prToken: args.prToken,
  prApiUrl: args.prApiUrl,
  mmcEnabled: args.mmcEnabled,
  mmcBackoffMinutes: args.mmcBackoffMinutes,
});
```

---

### 3. `/Users/gabe/lotlogic/supabase/functions/camera-snapshot/weak_plate_reads.ts`

**Import at top:**

```typescript
import { extractMmc, isMmcBlocked, handleMmcFailureStatus, type PrMmcData } from "./mmc.ts";
```

**`FlushArgs` type (lines 89–99) — add MMC fields (optional with defaults):**

Making these optional means a stale `cron-sessions-sweep` caller degrades gracefully to no-MMC rather than throwing a type error at runtime.

```typescript
type FlushArgs = {
  db: SupabaseClient;
  propertyId: string;
  groupKey: string;
  now: Date;
  prToken: string;
  prApiUrl: string;
  // Optional: when absent, MMC is disabled for this flush.
  mmcEnabled?: boolean;
  mmcBackoffMinutes?: number;
};
```

**`callPrViaUrl` function (lines 189–221) — full replacement:**

```typescript
async function callPrViaUrl(
  imageUrl: string,
  token: string,
  apiUrl: string,
  mmcEnabled = false,
  mmcBackoffMinutes = 60,
): Promise<{ plate: string; confidence: number | null; mmc?: PrMmcData; mmcRequested: boolean } | null> {
  const buildForm = (withMmc: boolean): FormData => {
    const form = new FormData();
    form.append("upload_url", imageUrl);
    form.append("regions", "us");
    if (withMmc) form.append("mmc", "true");
    return form;
  };

  const doCall = async (form: FormData): Promise<
    { ok: true; body: unknown } | { ok: false; status: number }
  > => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { Authorization: `Token ${token}` },
        body: form,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        console.warn(`callPrViaUrl: status ${res.status}`);
        return { ok: false, status: res.status };
      }
      return { ok: true, body: await res.json() };
    } catch (err) {
      clearTimeout(timer);
      console.warn(`callPrViaUrl failed: ${(err as Error)?.message ?? err}`);
      return { ok: false, status: 0 };
    }
  };

  const tryMmc = mmcEnabled && !isMmcBlocked();
  let body: unknown;
  let mmcRequested = false;

  if (tryMmc) {
    const first = await doCall(buildForm(true));
    if (!first.ok) {
      handleMmcFailureStatus(first.status, mmcBackoffMinutes);
      const retry = await doCall(buildForm(false));
      if (!retry.ok) return null;
      body = retry.body;
      mmcRequested = false;
    } else {
      body = first.body;
      mmcRequested = true;
    }
  } else {
    const attempt = await doCall(buildForm(false));
    if (!attempt.ok) return null;
    body = attempt.body;
  }

  const results = ((body as Record<string, unknown>)?.results ?? []) as Array<Record<string, unknown>>;
  if (results.length === 0) return null;
  const best = results.reduce((a, b) =>
    Number(b.score ?? 0) > Number(a.score ?? 0) ? b : a,
  );
  if (!best.plate) return null;
  return {
    plate:        best.plate as string,
    confidence:   typeof best.score === "number" ? (best.score as number) : null,
    mmc:          mmcRequested ? extractMmc(best) : undefined,
    mmcRequested,
  };
}
```

**Frame loop in `flushGroup` (lines 330–351) — add flush-scoped MMC flag and pass to `callPrViaUrl`:**

```typescript
const flushMmcEnabled = args.mmcEnabled ?? false;
const flushMmcBackoff = args.mmcBackoffMinutes ?? 60;
// Track whether entitlement failed in this flush so later frames skip the mmc attempt.
let mmcBlockedThisFlush = false;

let prMmcData: PrMmcData | undefined;
let prMmcRequested = false;

for (const frame of framesToTry) {
  const effectiveMmc = flushMmcEnabled && !mmcBlockedThisFlush;
  const pr = await callPrViaUrl(frame.image_url!, prToken, prApiUrl, effectiveMmc, flushMmcBackoff);
  if (!pr) continue;
  // If this call hit an entitlement failure and fell back, disable mmc for
  // remaining frames so we don't make doomed mmc attempts.
  if (pr.mmcRequested === false && effectiveMmc) {
    mmcBlockedThisFlush = true;
  }
  const norm = normalizePlate(pr.plate);
  if (norm.length < 4) continue;
  plateForMatch = norm;
  prUsed = true;
  prPlateRaw = pr.plate;
  prConfidence = pr.confidence;
  prFrameWinner = frame;
  prMmcData = pr.mmc;
  prMmcRequested = pr.mmcRequested;
  break;
}
```

**`plate_events` insert (lines 476–500) — add MMC columns:**

```typescript
const evIns = await db.from("plate_events").insert({
  property_id: propertyId,
  camera_id: chosenFrame.camera_id,
  plate_text: (prUsed && prPlateRaw && !tow ? prPlateRaw : chosenFrame.raw_plate).toUpperCase(),
  normalized_plate: plateForMatch,
  image_url: chosenFrame.image_url,
  ...mmcColumns(prMmcData),
  raw_data: {
    flow: tow ? "partner_truck_sighting" : "truck_plaza_exit",
    ocr_source: prUsed && !tow ? "pr_via_weak_buffer" : "sidecar_weak_buffer",
    pass_id: pass?.id ?? null,
    pass_match_fuzzy: pass?.fuzzy ?? false,
    overstay,
    burst_size: claimed.length,
    chosen_weak_read_id: chosenFrame.id,
    best_confidence_weak_read_id: best.id,
    sidecar_best_plate: best.raw_plate,
    sidecar_best_confidence: best.confidence,
    pr_used: prUsed && !tow,
    pr_confidence: prConfidence,
    pr_rescued_from_non_best_frame: !tow && prUsed && prFrameWinner.id !== best.id,
    tow_matched_on_non_best_frame: tow ? chosenFrame.id !== best.id : false,
    _pr_mmc_requested: prMmcRequested,
    _mmc: prMmcData ?? null,
    _mmc_source: prMmcData ? "pr_cloud" : null,
  },
  match_status: matchStatus,
  confidence: tow ? chosenFrame.confidence : (prUsed ? prConfidence : chosenFrame.confidence),
}).select("id").single();
```

**`insertViolation` call for unmatched path (lines 453–462) — thread MMC:**

The `insertViolation` function in `no_reg_violations.ts` must also accept MMC fields (see section 5 below). At the call site:

```typescript
const inserted = await insertViolation(db, {
  property_id: propertyId,
  normalized_plate: plateForMatch,
  raw_plate: prPlateRaw ?? best.raw_plate,
  best_confidence: prConfidence ?? best.confidence,
  first_seen_at: burst_min,
  last_seen_at: burst_max,
  presence_strength: burst_span_ms >= LINGER_MS ? "lingered" : "brief",
  evidence: bundleEvidence(evidenceRows),
  weak_read_ids: claimed.map((r) => r.id),
  vehicle_make:  prMmcData?.make  ?? null,
  vehicle_model: prMmcData?.model ?? null,
  vehicle_color: prMmcData?.color ?? null,
});
```

---

### 4. `/Users/gabe/lotlogic/supabase/functions/camera-snapshot/sessions.ts`

**`NewSessionInput` type (lines 732–750) — add five MMC fields after `vehicleType`:**

```typescript
vehicleType: string | null;
vehicleMake?:             string | null;
vehicleModel?:            string | null;
vehicleMakeConfidence?:   number | null;
vehicleColor?:            string | null;
vehicleColorConfidence?:  number | null;
```

**`insertSession` row object (lines 756–771) — add alongside `vehicle_type`:**

```typescript
vehicle_type:             input.vehicleType,
vehicle_make:             input.vehicleMake            ?? null,
vehicle_model:            input.vehicleModel           ?? null,
vehicle_make_confidence:  input.vehicleMakeConfidence  ?? null,
vehicle_color:            input.vehicleColor           ?? null,
vehicle_color_confidence: input.vehicleColorConfidence ?? null,
```

---

### 5. `/Users/gabe/lotlogic/supabase/functions/camera-snapshot/no_reg_violations.ts`

**`insertViolation` args (line 73) — add optional MMC fields:**

```typescript
export async function insertViolation(db: SupabaseClient, args: {
  property_id: string;
  normalized_plate: string;
  raw_plate: string;
  best_confidence: number;
  first_seen_at: Date;
  last_seen_at: Date;
  presence_strength: "brief" | "lingered";
  evidence: EvidenceItem[];
  weak_read_ids: string[];
  vehicle_make?:  string | null;
  vehicle_model?: string | null;
  vehicle_color?: string | null;
}): Promise<NoRegViolationRow>
```

**Row object in the function body — add the three fields:**

```typescript
const row = {
  property_id: args.property_id,
  // ... existing fields ...
  vehicle_make:  args.vehicle_make  ?? null,
  vehicle_model: args.vehicle_model ?? null,
  vehicle_color: args.vehicle_color ?? null,
};
```

---

### 6. `/Users/gabe/lotlogic/supabase/functions/cron-sessions-sweep/index.ts`

**Env block (near line 499) — add MMC constants:**

```typescript
const PR_MMC_ENABLED       = (Deno.env.get("PR_MMC_ENABLED")       ?? "false").toLowerCase() === "true";
const PR_MMC_BACKOFF_MINUTES = Number(Deno.env.get("PR_MMC_BACKOFF_MINUTES") ?? "60");
```

**Boot log — add MMC line:**

```typescript
console.log(`cron-sessions-sweep boot: mmc_enabled=${PR_MMC_ENABLED}`);
```

**`flushGroup` call (line 529) — add MMC args:**

```typescript
const r = await flushGroup({
  db,
  propertyId: g.property_id,
  groupKey: g.group_key,
  now,
  prToken: PR_TOKEN,
  prApiUrl: PR_API_URL,
  mmcEnabled: PR_MMC_ENABLED,
  mmcBackoffMinutes: PR_MMC_BACKOFF_MINUTES,
});
```

---

### 7. `/Users/gabe/lotlogic/supabase/functions/tow-dispatch-email/index.ts`

**Zero-migration interim option (before Phase 3 lands MMC in columns):** The full PR response is already in `plate_events.raw_data._pr_response`. Parse `results[0].model_make[0]` and `results[0].color[0]` from `raw_data` directly in the email function. This unblocks the email improvement during Sprint 1.

**Post-Phase-3 (first-class columns available):** Add `vehicle_make, vehicle_model, vehicle_color, vehicle_type` to the `plate_events` select at line ~205. At line ~519 (HTML meta table):

```typescript
${(plateMake || plateColor || plateVehicleType)
  ? metaRow("Vehicle", [plateColor, plateVehicleType, plateMake, plateModel].filter(Boolean).join(" "))
  : ""}
```

At line ~375 (plain-text body):

```
VEHICLE: ${[plateColor, vehicleType, plateMake, plateModel].filter(Boolean).join(" ") || "unknown"}
```

---

### 8. `/Users/gabe/lotlogic/frontend/dashboard.html`

All five surfacing ranks are unchanged from the draft. Sequence after Phase 3 confirms data flows:

- Rank 1 (email): ship in Sprint 4, parallel to or immediately after Phase 1 (no SPA risk, raw_data parse available immediately).
- Ranks 2–5 (dashboard): after Phase 3 confirms MMC columns are populated. One-line select additions + conditional spans. No new hooks or state.

Naming compliance: all labels use "Vehicle", never "Resident", "Driver", "Guest".

---

## `TruckPlazaArgs` — Pass MMC Through from index.ts

Since truck_plaza_exit.ts no longer reads env vars directly, the `handleTruckPlazaExit` call site in index.ts must pass MMC args:

```typescript
const result = await handleTruckPlazaExit({
  db,
  camera,
  payload,
  now,
  uploadJpeg,
  prToken: PR_TOKEN,
  prApiUrl: PR_SDK_URL || "https://api.platerecognizer.com/v1/plate-reader/",
  sidecarRead: ...,
  bypassSidecarGate: ...,
  notifyLeftBeforeTow: ...,
  mmcEnabled: wantMmc,
  mmcBackoffMinutes: PR_MMC_BACKOFF_MINUTES,
});
```

---

## Data Flow

```
Camera POST
  └─► index.ts: extract bytes
        └─► wantMmc gate (property context)
        └─► callPlateRecognizer(bytes, cameraId, wantMmc, backoffMin)
              ├─ if wantMmc && !isMmcBlocked() → doFetch(form+mmc=true)
              │     ├─ 200 → return {ok:true, mmcRequested:true}
              │     └─ non-200 → handleMmcFailureStatus(status) → doFetch(form, no mmc)
              │           ├─ 200 → return {ok:true, mmcRequested:false}
              │           └─ non-200 → return {ok:false} → same drop as today
              └─ else → doFetch(form, no mmc) → return {ok:true, mmcRequested:false}
        └─► for each surviving result:
              ├─ vehicleType = result.vehicle?.type (always, no MMC gate)
              ├─ mmcSourceResult: real result or prResp.data.results[0] if USDOT-synthesized
              ├─ mmcData = mmcRequested ? extractMmc(mmcSourceResult) : undefined
              ├─ baseEventRow: ...mmcColumns(mmcData), raw_data._mmc, _mmc_source
              ├─ insertSession: vehicleMake/Model/Color/Confidence from mmcData
              └─ alpr_violations (cooldown): vehicle_type=vehicleType, make/model/color=mmcData

Camera POST (truck_plaza path)
  └─► handleTruckPlazaExit(args + mmcEnabled, mmcBackoffMinutes)
        ├─ bypassSidecarGate: callPlateRecognizerCloud(no mmc) → resolved{source:"pr", mmc:undefined}
        ├─ low-conf rescue: callPlateRecognizerCloud(mmcEnabled) → resolved{source:"pr", mmc:PrMmcData}
        ├─ onboard LPR: resolved{source:"onboard"}
        └─ plate_events insert: reconcile resolved.source === "pr" ? resolved.mmc : onboard fields
        
        ├─ opportunistic flushGroup(mmcEnabled, mmcBackoffMinutes)
              └─ callPrViaUrl (up to 3 frames, flush-scoped mmcBlockedThisFlush gate)
                    └─ plate_events insert: mmcColumns(prMmcData)
                    └─ insertViolation (unmatched): vehicle_make/model/color from prMmcData

Cron sweep
  └─► flushGroup(mmcEnabled=PR_MMC_ENABLED) [reads from cron's own env]
        └─ same callPrViaUrl path as above
```

---

## Build Sequence Checklist

### Sprint 1 — Schema + Safety Infrastructure (ships flag-off, zero behavior change)

- [ ] Create `/Users/gabe/lotlogic/migrations/026_evidence_photo_url.sql` (reconstruct from production schema; verify columns match before committing)
- [ ] Create `/Users/gabe/lotlogic/migrations/027_vehicle_mmc_columns.sql` (as specified above, including `alpr_violations_violation_type_ck` repair and `no_registration_violations` MMC columns)
- [ ] Apply migration 026 via `supabase db push` or Supabase MCP `apply_migration` — verify it is a no-op (columns already exist in production)
- [ ] Apply migration 027 via `supabase db push`
- [ ] Confirm schema: `SELECT column_name, table_name FROM information_schema.columns WHERE table_name IN ('plate_events','plate_sessions','alpr_violations','no_registration_violations') AND column_name LIKE 'vehicle_%' ORDER BY table_name, column_name;`
- [ ] Confirm constraint repair: `SELECT constraint_name, check_clause FROM information_schema.check_constraints WHERE constraint_name = 'alpr_violations_violation_type_ck';` — expect `cooldown` to appear
- [ ] Create `/Users/gabe/lotlogic/supabase/functions/camera-snapshot/mmc.ts`
- [ ] Patch `index.ts`: env constants, boot log + entitlement warning, import, `PrResult` type, `callPlateRecognizer` (full replacement), `wantMmc` gate at line 797, MMC extraction after line 926 (including USDOT-synthesized branch), `baseEventRow` MMC columns + raw_data fields, `insertSession` call MMC args, `alpr_violations` cooldown insert MMC + `vehicle_type` fix
- [ ] Patch `sessions.ts`: `NewSessionInput` five new fields, `insertSession` row object five new columns
- [ ] Patch `no_reg_violations.ts`: `insertViolation` args + row object for `vehicle_make/model/color`
- [ ] Patch `truck_plaza_exit.ts`: import mmc.ts, `ResolvedPlate` type (add `mmc`, `mmcRequested`), `handleTruckPlazaExit` args (add `mmcEnabled`, `mmcBackoffMinutes`), full `callPlateRecognizerCloud` replacement, bypassSidecarGate block (no mmc, carry mmc fields onto resolved), low-conf rescue block (pass mmc args, carry result), reconciliation at plate_events insert (use `"pr"` not `"pr_cloud"`), both opportunistic `flushGroup` calls (lines ~444, ~473) add `mmcEnabled`/`mmcBackoffMinutes`
- [ ] Patch `weak_plate_reads.ts`: import mmc.ts, `FlushArgs` type (add optional `mmcEnabled`, `mmcBackoffMinutes`), full `callPrViaUrl` replacement, frame loop (`flushMmcEnabled`, `mmcBlockedThisFlush` gate, `prMmcData` capture), `plate_events` insert (add MMC columns), `insertViolation` call (add `vehicle_make/model/color`)
- [ ] Patch `cron-sessions-sweep/index.ts`: MMC env constants, boot log, `flushGroup` call add `mmcEnabled`/`mmcBackoffMinutes`
- [ ] Confirm `PR_MMC_ENABLED` is NOT set (or explicitly `=false`) in Supabase secrets
- [ ] `supabase functions deploy camera-snapshot`
- [ ] `supabase functions deploy cron-sessions-sweep` (same sprint, same deploy window)
- [ ] Tail logs: confirm boot line shows `mmc_enabled=false`
- [ ] Verify one live `plate_events` row: `SELECT raw_data->>'_pr_mmc_requested', vehicle_make FROM plate_events ORDER BY created_at DESC LIMIT 1;` — expect `false` and `NULL`

### Sprint 2 — Walk-Around Hardening (BLOCKING prerequisite for Phase 3)

- [ ] `supabase functions download walk-around-ocr --project-ref nzdkoouoaedbbccraoti` — diff against repo branch, commit deployed source
- [ ] **If Phase 0 (below) shows 4xx on mmc=true**: walk-around-ocr is broken in production today for any operator scan — treat Sprint 2 as P0, not parallel work. Fix immediately.
- [ ] Verify whether deployed v3 implements mmc retry fallback. If not, add `callPrWithMmcFallback` wrapper using the same pattern as `callPrViaUrl`.
- [ ] Change `PR_MMC` default to `"false"` in walk-around-ocr env block
- [ ] Response contract: add `mmc_attempted: boolean` and `mmc_available: boolean` to the walk-around-ocr HTTP response body. When fallback fires: `mmc_attempted=true, mmc_available=false`. When PR succeeds with MMC: `mmc_attempted=true, mmc_available=true`. When `PR_MMC=false`: `mmc_attempted=false`. Document this as the tow-write contract.
- [ ] Make `vehicle.make/model/color` nullable in response when MMC falls back
- [ ] `supabase functions deploy walk-around-ocr`
- [ ] Test: operator scan must succeed regardless of `PR_MMC` setting

### Phase 0 — Entitlement Check (before Phase 3; may inform Sprint 2 urgency)

```bash
curl -X POST https://api.platerecognizer.com/v1/plate-reader/ \
  -H "Authorization: Token $PLATE_RECOGNIZER_TOKEN" \
  -F "upload=@test_plate.jpg" \
  -F "mmc=true" | jq .
```

- 200 + `results[0].model_make` populated: MMC entitled. Proceed to Phase 3.
- 200 + `model_make` absent: plan active, MMC add-on not enabled. Contact PR support (+50% plan fee). Code ships and data flows once plan upgrades.
- 4xx: MMC not enabled. **Walk-around-ocr is already failing for every operator scan** (Sprint 2 is P0). Set `PR_MMC_ENTITLEMENT_CONFIRMED=false` in secrets. Do not proceed to Phase 3 until entitled.
- Log the response body verbatim as the entitlement baseline.

### Phase 3 — Flip Flag ON (requires Sprint 1 deployed + Sprint 2 complete + Phase 0 entitled)

- [ ] Set `supabase secrets set PR_MMC_ENTITLEMENT_CONFIRMED=true PR_MMC_ENABLED=true PR_MMC_BACKOFF_MINUTES=60 PR_MMC_ENFORCEMENT_SITES_ONLY=false`
- [ ] Tail edge function logs for 10 minutes. The boot line shows `mmc_enabled=true mmc_entitlement_confirmed=true`. Watch for `[callPlateRecognizer] mmc attempt returned 4xx` — if it appears, entitlement probe was wrong; set `PR_MMC_ENABLED=false` immediately.
- [ ] After ~30 minutes of live traffic, run the confirmation query:

```sql
SELECT
  id, created_at, plate_text,
  raw_data->>'_pr_mmc_requested'  AS mmc_requested,
  raw_data->>'_mmc_source'        AS mmc_source,
  raw_data->'_mmc'->>'make'       AS make,
  raw_data->'_mmc'->>'color'      AS color,
  vehicle_make, vehicle_color
FROM plate_events
WHERE created_at > now() - interval '2 hours'
  AND raw_data->>'_pr_mmc_requested' = 'true'
ORDER BY created_at DESC
LIMIT 20;
```

Success criteria: `mmc_requested = 'true'`, `mmc_source = 'pr_cloud'`, `make` is a recognizable brand, `vehicle_make` non-null.

Entitlement not active: `mmc_requested = 'true'`, `make IS NULL`, `vehicle_make IS NULL`. Contact PR.

Fallback fired correctly: `mmc_requested = 'false'` on some rows, `vehicle_make IS NULL`, but `plate_text` is populated.

- [ ] Confirm no read-rate drop:

```sql
SELECT date_trunc('hour', created_at) AS hour, count(*) AS reads
FROM plate_events
WHERE created_at > now() - interval '48 hours'
GROUP BY 1 ORDER BY 1 DESC;
```

A sudden drop at the hour `PR_MMC_ENABLED` was set means the retry is not firing correctly — set `SYSTEM_PAUSED=true` immediately, then investigate.

### Sprint 4 — Email Surfacing (no SPA risk; can ship after Phase 1)

- [ ] Interim: parse MMC from `raw_data._pr_response.results[0]` in tow-dispatch-email (no column dependency)
- [ ] Add `vehicle_make, vehicle_model, vehicle_color, vehicle_type` to `plate_events` select (post-Phase-3)
- [ ] Add "Vehicle" row to HTML meta table and plain-text body
- [ ] `supabase functions deploy tow-dispatch-email`

### Sprint 5 — Dashboard Surfacing (after Phase 3 confirmed)

- [ ] `getRecentPlateEvents` select: add `vehicle_make, vehicle_model, vehicle_color`; add vehicle span to Plate Detections feed row
- [ ] `getOpenSessions` select: add MMC fields; update session vehicle span
- [ ] `getALPRViolations` and `getAllALPRViolations` selects: add MMC fields (violation cards auto-populate from existing scaffold at line 5726)
- [ ] `getLatestPlateEventForPlate` select: add MMC fields; render in `VehicleImage` + push `detailChips` entry
- [ ] Test each change in isolation (in-browser Babel SPA — a syntax error blanks the entire app)

### Sprint 6 — Tow-Write Edge Function (future, separate design)

- [ ] Create migration 028: add `'walk_around'` to `alpr_violations_violation_type_ck`
- [ ] Build tow-write edge function scoped by `properties.tow_company_id`
- [ ] Insert `plate_events` row (`event_type = 'patrol'`) then `alpr_violations` with `vehicle_make/model/color/type` from walk-around-ocr response
- [ ] Consume `mmc_attempted` / `mmc_available` from walk-around-ocr response to distinguish "MMC not configured" from "MMC returned null make"

---

## Rollback

**Immediate (no redeploy):** `supabase secrets set PR_MMC_ENABLED=false`. Takes effect on next invocation. Secret propagation on Supabase edge functions is ~60 seconds — during that window, reads continue on the mmc path. If reads are actively dropping (not merely degrading to no-MMC), use `SYSTEM_PAUSED=true` first to halt all processing immediately. Then set `PR_MMC_ENABLED=false`. Confirm with a log-tail before unsetting `SYSTEM_PAUSED`.

**Full code rollback:** Redeploy the pre-patch function. Schema columns remain (nullable, no harm) — they stay null.

**Hard outage sequence:**
1. `supabase secrets set SYSTEM_PAUSED=true` — halts all processing immediately
2. Wait for in-flight invocations to complete (~15 seconds)
3. `supabase secrets set PR_MMC_ENABLED=false PR_MMC_ENTITLEMENT_CONFIRMED=false`
4. `supabase secrets set SYSTEM_PAUSED=false`
5. Tail logs to confirm reads resume without mmc attempts

---

## Implementation File Map

**Files to CREATE:**
- `/Users/gabe/lotlogic/migrations/026_evidence_photo_url.sql`
- `/Users/gabe/lotlogic/migrations/027_vehicle_mmc_columns.sql`
- `/Users/gabe/lotlogic/supabase/functions/camera-snapshot/mmc.ts`

**Files to MODIFY:**
- `/Users/gabe/lotlogic/supabase/functions/camera-snapshot/index.ts` — env constants (~line 14), boot log (~185), import, `PrResult` type (~1623), `callPlateRecognizer` (~1432), call site at ~797, MMC extraction after ~926, `baseEventRow` (~1013), `insertSession` call (~1244), `alpr_violations` cooldown insert (~1288), `handleTruckPlazaExit` call (pass `mmcEnabled`, `mmcBackoffMinutes`)
- `/Users/gabe/lotlogic/supabase/functions/camera-snapshot/sessions.ts` — `NewSessionInput` type (~732), `insertSession` row object (~756)
- `/Users/gabe/lotlogic/supabase/functions/camera-snapshot/no_reg_violations.ts` — `insertViolation` args (~73) and row object (~84)
- `/Users/gabe/lotlogic/supabase/functions/camera-snapshot/truck_plaza_exit.ts` — import, `ResolvedPlate` type (~67), `handleTruckPlazaExit` args (~368), `callPlateRecognizerCloud` (~336), bypassSidecarGate block (~415), low-conf rescue block (~499), plate_events insert reconciliation (~613), two opportunistic `flushGroup` calls (~444, ~473)
- `/Users/gabe/lotlogic/supabase/functions/camera-snapshot/weak_plate_reads.ts` — import, `FlushArgs` type (~89), `callPrViaUrl` (~189), frame loop (~330), plate_events insert (~476), `insertViolation` call (~453)
- `/Users/gabe/lotlogic/supabase/functions/cron-sessions-sweep/index.ts` — MMC env constants (~499), boot log, `flushGroup` call (~529)
- `/Users/gabe/lotlogic/supabase/functions/tow-dispatch-email/index.ts` — plate_event select (~205), text body (~375), HTML meta table (~519)
- `/Users/gabe/lotlogic/frontend/dashboard.html` — five targeted select + render edits (lines ~3372, ~3385, ~3395, ~3447/3466, ~9558, ~10841, ~10991)

---

## Decisions & Open Questions

**Decisions made (no longer open):**

1. `PR_MMC_ENFORCEMENT_SITES_ONLY` replaces `PR_MMC_UNMATCHED_ONLY`. The rename reflects the actual implementation (property-type gate, not match-outcome gate). Default remains `false`.

2. MMC is NOT sent on bypassSidecarGate frames. These are probe calls to determine if a plate exists at all. Sending `mmc=true` on no-plate frames doubles the retry cost on the entitlement-failure path at the highest-volume call site. Post-plate MMC (low-conf rescue) is the correct scope.

3. `vehicle_type` is always sourced from `vehicleType` (the line-926 extraction from `result.vehicle?.type`) in all `alpr_violations` inserts, not from `mmcData?.vehicle_type`. This ensures the column is populated regardless of MMC plan status, since PR always returns `vehicle.type`.

4. `_mmc_source` in `raw_data` (values: `"pr_cloud"`, `"onboard_lpr"`, or absent/null) distinguishes the three states — PR MMC, onboard LPR attributes, and neither — without a new schema column.

5. Entitlement failure detection narrows to HTTP 402 and 403 only. HTTP 429 triggers a separate 5-minute rate-limit backoff. All other non-200 responses trigger the retry-without-mmc but do not set any backoff gate.

6. `FlushArgs.mmcEnabled` and `FlushArgs.mmcBackoffMinutes` are optional with defaults (`false`, `60`). This ensures a stale `cron-sessions-sweep` caller degrades to no-MMC rather than throwing at runtime. The cron is still patched in Sprint 1 and deployed in the same window.

7. `no_registration_violations` receives MMC columns. The SC211 unmatched path is the highest-operator-value MMC surface (plate may be OCR garbage; vehicle description is real). This is the primary way an operator will see "White Freightliner Cascadia" for a vehicle they cannot match by plate.

8. Migration 027 repairs the pre-existing `alpr_violations_violation_type_ck` constraint gap (missing `'cooldown'`). This is independent of MMC — the `cooldown` INSERT at index.ts line 1293 is currently in violation of the constraint. Sprint 6 adds `'walk_around'` in migration 028.

**Open questions (implementer must resolve):**

1. **PR plan status and current walk-around-ocr state.** Phase 0 (manual entitlement POST) answers both. If the POST returns 4xx, Sprint 2 is a P0 fix (walk-around-ocr is already broken for every operator scan), not a parallel sprint. This is the first action before any Sprint 1 code ships to production with the flag.

2. **PR behavior on `mmc=true` with an unentitled plan.** Empirically unknown — may return 402, 403, or 200 with `model_make` absent (silent ignore). The Phase 0 check resolves this. The retry design is correct regardless: any non-200 retries without mmc; a 200 with no `model_make` simply means `extractMmc` returns `undefined` and columns stay null.

3. **SDK endpoint and MMC support.** If `PR_SDK_URL` is set (on-premise SDK), does the SDK version support `mmc=true`? If not, the SDK will return 4xx on mmc requests and the fallback fires on every SDK read. This is correct safe behavior but produces a constant log warning. Resolve by checking the deployed SDK version's changelog before enabling the flag.

4. **Migration 026 exact DDL.** The reconstruction above is based on MEMORY.md references. Verify the actual columns present in production's `alpr_violations` before committing. A mismatch means `supabase db push` will try to re-add columns that already exist — the `IF NOT EXISTS` guard makes this a no-op, but the commit history should reflect reality.

5. **Low-conf rescue soft-threshold variance.** When `callPlateRecognizerCloud` with `mmc=true` returns a 200 response but confidence below `PR_RESOLVE_FLOOR` (0.40), the read is dropped — identical to today's behavior. The retry-without-mmc only fires on non-200 responses. There is a low-probability scenario where the mmc=true call scores 0.38 and a no-mmc retry might score 0.42 on the same image. This is not corrected in this design. If it manifests as observable false-positive overstay violations on the south camera, add a second confidence-floor retry in the low-conf rescue block at that time.