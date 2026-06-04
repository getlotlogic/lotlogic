// mmc.ts — shared MMC (make/model/color) types, extraction, and
// entitlement-failure backoff for the camera-snapshot pipeline.
//
// IMPORTANT: the module-level backoff variables below are shared across ALL
// importers within the same Deno isolate (one edge-function invocation, or
// across requests in a warm isolate's lifetime). This is INTENTIONAL: a single
// entitlement failure suppresses mmc for all subsequent PR calls in the same
// isolate, regardless of which call site triggered it. Do NOT move these into
// individual call-site files — that would break cross-call-site suppression.

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

// Call on HTTP 402/403 — plan does not include MMC. Suppress all further mmc
// attempts for backoffMinutes (within this isolate).
export function recordMmcEntitlementFailure(backoffMinutes: number): void {
  _mmcUnentitledUntil = Date.now() + backoffMinutes * 60_000;
  console.warn(`[mmc] entitlement failure (402/403); suppressing mmc for ${backoffMinutes}m within this isolate`);
}

// Call on HTTP 429 — rate limit, not entitlement. Short backoff only.
export function recordMmcRateLimit(): void {
  _mmcRateLimitedUntil = Date.now() + 5 * 60_000;
  console.warn("[mmc] rate limited (429); suppressing mmc for 5m within this isolate");
}

// Extract top-ranked MMC fields from a single PR results[] entry.
// Returns undefined when no MMC data is present (non-mmc plan or mmc=false).
// NOTE: vehicle_type (result.vehicle?.type) is available regardless of the MMC
// plan; extract it at the call site from the raw result, not from here.
export function extractMmc(result: unknown): PrMmcData | undefined {
  const r = (result ?? {}) as Record<string, unknown>;
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

// Columns to spread into a plate_events / plate_sessions / violation insert.
// vehicle_type is NOT included — source it from the call site's own
// vehicleType (available on every PR call regardless of MMC plan).
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

// Record the right backoff for an MMC-request failure HTTP status.
// Returns true if a backoff was recorded.
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
