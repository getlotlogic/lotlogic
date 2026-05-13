import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePlate } from "../pr-ingest/normalize.ts";
import { hammingDistance } from "./image-hash.ts";

// dHash Hamming-distance threshold for "same scene" matching. ≤ 8 of 64
// bits = essentially identical scene with minor motion (slow-moving truck,
// trailer creak, lighting flicker). 5 is "byte-identical-after-recompress",
// 12 is "different angle of the same area". 8 is the sweet spot for
// collapsing burst frames of the same physical vehicle even when PR's plate
// reads drift heavily.
export const DHASH_BURST_THRESHOLD = 8;

export type OpenSessionRow = {
  id: string;
  property_id: string;
  normalized_plate: string;
  plate_text: string;
  state: "grace" | "registered" | "resident" | "expired";
  entered_at: string;
  last_detected_at?: string;  // bumped on every re-read; used for dedup→exit gate
  visitor_pass_id: string | null;
  resident_plate_id: string | null;
  violation_id: string | null;
};

export async function findOpenSession(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
): Promise<OpenSessionRow | null> {
  const { data, error } = await db
    .from("plate_sessions")
    .select("id,property_id,normalized_plate,plate_text,state,entered_at,last_detected_at,visitor_pass_id,resident_plate_id,violation_id")
    .eq("property_id", propertyId)
    .eq("normalized_plate", normalizedPlate)
    .is("exited_at", null)
    .limit(1);
  if (error) throw error;
  return (data ?? [])[0] ?? null;
}

export type CooldownHit = {
  prior_session_id: string;
  prior_exited_at: string;
  cooldown_hours: number;
};

/**
 * 24-hour cooldown (anti-camping) enforcement.
 *
 * Returns the most recent closed-and-parked session for this plate at this
 * property, IF its exit was within the property's cooldown_hours window. Null
 * means no cooldown applies — open a normal grace session.
 *
 * Triggers an immediate `cooldown` violation on the next session open (no
 * 15-min grace). Residents and visitors-with-active-pass are exempt: callers
 * skip this check when they have a match.
 *
 * "Parked" = a session that wasn't a transient drive-through. The check
 * uses exited_at - entered_at > 2 minutes as the floor; shorter dwells are
 * treated as drive-throughs and don't trigger cooldown.
 */
export async function findCooldownPriorSession(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
  now: Date,
): Promise<CooldownHit | null> {
  const { data: propRows, error: propErr } = await db
    .from("properties")
    .select("cooldown_hours")
    .eq("id", propertyId)
    .limit(1);
  if (propErr) throw propErr;
  const cooldownHours = propRows?.[0]?.cooldown_hours ?? null;
  if (cooldownHours === null || cooldownHours <= 0) return null;

  const cutoff = new Date(now.getTime() - cooldownHours * 3600 * 1000).toISOString();
  // Cooldown only applies to vehicles that were REGISTERED on their prior
  // visit (had an active pass or resident match). Unregistered grace
  // sessions get thrown away at 15 min with no violation — they aren't
  // tracked, so they can't trip cooldown either.
  // Match against either plate column — a driver may have entered showing
  // front plate and exited showing back plate (or vice versa), and the same
  // vehicle should be on cooldown regardless of which plate the camera reads
  // on re-entry.
  const { data, error } = await db
    .from("plate_sessions")
    .select("id,entered_at,exited_at,normalized_plate,normalized_back_plate,visitor_pass_id,resident_plate_id")
    .eq("property_id", propertyId)
    .or(`normalized_plate.eq.${normalizedPlate},normalized_back_plate.eq.${normalizedPlate}`)
    .not("exited_at", "is", null)
    .gt("exited_at", cutoff)
    .order("exited_at", { ascending: false })
    .limit(10);
  if (error) throw error;
  // Find the most-recent prior session that was BOTH registered AND a real
  // park (≥2 min dwell). Iterating: a registered drive-through doesn't block
  // a later legitimate park, and we don't want a drive-through "first hit"
  // to short-circuit the dwell check and miss an older park within the
  // cooldown window.
  type Row = {
    id: string;
    entered_at: string;
    exited_at: string | null;
    visitor_pass_id: string | null;
    resident_plate_id: string | null;
  };
  for (const r of (data ?? []) as Row[]) {
    if (!r.exited_at) continue;
    if (!(r.visitor_pass_id || r.resident_plate_id)) continue;
    const dwellMs = new Date(r.exited_at).getTime() - new Date(r.entered_at).getTime();
    if (dwellMs < 2 * 60 * 1000) continue; // drive-through, skip
    return {
      prior_session_id: r.id,
      prior_exited_at: r.exited_at,
      cooldown_hours: cooldownHours,
    };
  }
  return null;
}

// Fuzzy plate equality for OCR drift. ALPR engines routinely misread one
// character per frame and sometimes drop/add leading characters as a vehicle
// moves through the frame. Without this, one physical truck becomes multiple
// "plates" and therefore multiple sessions/violations/emails.
//
// Match rule: a ≡ b iff
//   (1) Levenshtein(a, b) ≤ 1  (single char substitution/insertion/deletion)
//   OR
//   (2) one is a substring of the other AND length difference ≤ 3
//       (catches partial reads like HD4183 vs VHD4183)
// ALPR OCR confusion pairs — character substitutions that PR makes
// predictably due to character shape similarity. These count as zero-cost
// substitutions in plateSimilar so e.g. "LFV2510" and "LFV25IO" match.
//
// The base list below is curated from Plate Recognizer drift logs on
// Charlotte data + standard ALPR misread literature. Order doesn't
// matter; pairs are bidirectional. Adding too many here loosens cross-
// vehicle matching, so each addition needs a real-world precedent —
// don't add character pairs that LOOK similar in a font but PR has
// never actually misread.
//
// The auto-tuner (scripts/modal-tune-fuzzy.py) runs weekly, mines
// plate_events grouped by session_id (ground truth from matching +
// downstream allowlist hits), and commits additional pairs to
// auto-fuzzy-config.json. The base list and the auto-mined list merge
// here at startup — auto-mined pairs are ADDITIVE, never replace the
// base.
import autoFuzzyConfig from "./auto-fuzzy-config.json" with { type: "json" };

const OCR_CONFUSIONS_BASE: Array<[string, string]> = [
  // Letter ↔ digit (most common in production)
  ["O", "0"], ["D", "0"], ["Q", "0"],
  ["I", "1"], ["L", "1"],
  ["Z", "2"],
  ["S", "5"],
  ["G", "6"],
  ["T", "7"], ["Y", "7"],
  ["B", "8"],
  ["G", "9"], ["q", "9"],
  // Letter ↔ letter (shape-similar)
  ["I", "L"],
  ["D", "Q"],
  ["T", "Y"],
  ["U", "V"],
  ["M", "N"],
  ["M", "W"],
  ["B", "R"],   // muddy plates
  ["F", "P"],   // partial-occlusion or dirty plates
  ["C", "G"],   // CHARLOTTE prod 2026-04-22 — observed multiple times
  ["O", "Q"],
  ["E", "F"],
];

const OCR_CONFUSIONS: Array<[string, string]> = (() => {
  const seen = new Set<string>();
  const merged: Array<[string, string]> = [];
  const add = (a: string, b: string) => {
    const key = [a, b].sort().join("|");
    if (seen.has(key)) return;
    seen.add(key);
    merged.push([a, b]);
  };
  for (const [a, b] of OCR_CONFUSIONS_BASE) add(a, b);
  // Auto-mined pairs; ignored if the JSON is the stub (length 0).
  const auto = (autoFuzzyConfig as { ocr_confusions?: Array<{ pair: string[] }> }).ocr_confusions ?? [];
  for (const entry of auto) {
    if (entry.pair && entry.pair.length === 2) add(entry.pair[0], entry.pair[1]);
  }
  return merged;
})();

function areCharsConfusable(a: string, b: string): boolean {
  if (a === b) return true;
  for (const [x, y] of OCR_CONFUSIONS) {
    if ((a === x && b === y) || (a === y && b === x)) return true;
  }
  return false;
}

// Partial-read match against an allowlisted plate.
//   Returns true when the SHORTER of (read, allowlist) is a substring of the
//   LONGER one AND the shorter is at least `minRatio` of the longer's length
//   (default 50%). Used as a last-resort fallback when the strict matcher
//   misses a partial read of a registered plate (e.g. truck partially
//   obscures plate, camera caught only a 5-char fragment of a 7-char plate).
//
// The session that registers via this path will have read_plate ≠ pass_plate
// and surfaces in the Training tab's Fuzzy Matches mode for operator review.
export function plateMatchesPartial(read: string, registered: string, minRatio = 0.5): boolean {
  if (!read || !registered) return false;
  const r = String(read).toUpperCase();
  const p = String(registered).toUpperCase();
  if (r === p) return true;
  const [shorter, longer] = r.length <= p.length ? [r, p] : [p, r];
  if (shorter.length < 2) return false; // ≤1-char "matches" are noise
  if (shorter.length / longer.length < minRatio) return false;
  return longer.includes(shorter);
}

// Two plates match if:
//  - Equal
//  - One is a substring of the other with length diff ≤ 3 (partial reads)
//  - Same-length reads differ only in OCR-confusable chars + up to N true edits
//    where N = 2 for anchored sessions, 1 otherwise
//  - Different-length reads within bounded Levenshtein
export function plateSimilar(a: string, b: string, anchored: boolean = false): boolean {
  if (a === b) return true;
  if (a.length === 0 || b.length === 0) return false;
  // Anchored mode is used when matching against an EXISTING session's plate
  // — false positives there cross two different real vehicles' sessions.
  // The substring shortcut + levenshtein-≤-2 was loose enough to collide
  // legitimately distinct plates ("HD4183" vs "VHD4188" → 2 edits, hit).
  // Tighten anchored mode to: same length, ≤1 non-confusion difference.
  if (anchored) {
    if (a.length !== b.length) return false;
    let trueEdits = 0;
    for (let i = 0; i < a.length; i++) {
      if (!areCharsConfusable(a[i], b[i])) {
        trueEdits++;
        if (trueEdits > 1) return false;
      }
    }
    return true;
  }

  // Unanchored mode (used for NEW session matching) keeps the looser
  // behavior — false positives there just collapse two reads of the same
  // plate into one session, which is the desired effect.
  if (Math.abs(a.length - b.length) <= 3 && (a.includes(b) || b.includes(a))) return true;
  if (a.length === b.length) {
    let trueEdits = 0;
    for (let i = 0; i < a.length; i++) {
      if (!areCharsConfusable(a[i], b[i])) {
        trueEdits++;
        if (trueEdits > 1) return false;
      }
    }
    return true;
  }
  return levenshteinBounded(a, b, 1) <= 1;
}

// Levenshtein distance with early exit when distance exceeds `max`.
// Returns min(actual_distance, max+1).
function levenshteinBounded(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Find an open session whose recent frames have an image dHash visually
// similar to the incoming frame. Used to collapse bursts of the same
// physical vehicle into one session even when PR's plate reads drift
// across frames (e.g. "ABC123" in frame 1, "ABCl23" in frame 2,
// "ABC1Z3" in frame 3). Plate-similarity matching alone is brittle in
// these cases — image similarity is what proves "this is literally the
// same truck, regardless of what OCR returned."
//
// Strategy:
//   - Pull recent plate_events on this property within the time window
//     that have a non-null image_dhash.
//   - For each event, compute Hamming distance against the incoming
//     dHash. If ≤ DHASH_BURST_THRESHOLD, that event's session is a
//     match.
//   - Return the most recently-active matching session.
//
// Cost: one Postgres query (~5ms) + N Hamming-distance calculations
// (~µs each). At Charlotte scale, N is typically 10-50 events.
export async function findOpenSessionByImageHash(
  db: SupabaseClient,
  propertyId: string,
  imageDhash: string,
  withinSeconds: number = 180,
): Promise<OpenSessionRow | null> {
  if (!imageDhash) return null;
  const cutoffIso = new Date(Date.now() - withinSeconds * 1000).toISOString();
  const { data: events, error: evErr } = await db
    .from("plate_events")
    .select("session_id, image_dhash")
    .eq("property_id", propertyId)
    .gte("created_at", cutoffIso)
    .not("session_id", "is", null)
    .not("image_dhash", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (evErr) throw evErr;
  if (!events || events.length === 0) return null;

  // Find the closest-matching session_id by minimum Hamming distance.
  let bestSessionId: string | null = null;
  let bestDist = DHASH_BURST_THRESHOLD + 1;
  for (const ev of events) {
    if (!ev.image_dhash || !ev.session_id) continue;
    const dist = hammingDistance(imageDhash, ev.image_dhash);
    if (dist <= DHASH_BURST_THRESHOLD && dist < bestDist) {
      bestDist = dist;
      bestSessionId = ev.session_id;
    }
  }
  if (!bestSessionId) return null;

  const { data: openRows, error: sErr } = await db
    .from("plate_sessions")
    .select("id,property_id,normalized_plate,plate_text,state,entered_at,last_detected_at,visitor_pass_id,resident_plate_id,violation_id")
    .eq("id", bestSessionId)
    .is("exited_at", null)
    .limit(1);
  if (sErr) throw sErr;
  return ((openRows ?? [])[0] as OpenSessionRow) ?? null;
}

// Find an open session whose plate is EQUAL OR FUZZY-SIMILAR to the incoming
// plate, scoped to the property and the last `withinSeconds` seconds of entry.
// Fast path: exact match via findOpenSession. Slow path: pull recent open
// sessions and run plateSimilar() client-side. At a truck plaza we typically
// have 0-10 open sessions, so client-side is cheap and avoids a pg extension.
export async function findSimilarOpenSession(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
  withinSeconds: number = 120,
  usdotNumber: string | null = null,
  mcNumber: string | null = null,
  imageDhash: string | null = null,
): Promise<OpenSessionRow | null> {
  const exact = await findOpenSession(db, propertyId, normalizedPlate);
  if (exact) return exact;

  // Image-hash burst match. If the incoming frame is visually nearly
  // identical to a recent frame on this property, treat it as the same
  // physical vehicle regardless of what plate text PR returned. This is
  // the strongest signal we have for "burst of the same car" — works
  // even when OCR drift drops length, swaps non-confusion characters,
  // or returns a totally different plate string.
  if (imageDhash) {
    const byImage = await findOpenSessionByImageHash(db, propertyId, imageDhash, withinSeconds);
    if (byImage) return byImage;
  }

  // If we have a USDOT, check for an open session with that USDOT first —
  // one physical truck can read plate in one frame and DOT in another.
  if (usdotNumber) {
    const { data, error } = await db
      .from("plate_sessions")
      .select("id,property_id,normalized_plate,plate_text,state,entered_at,last_detected_at,visitor_pass_id,resident_plate_id,violation_id")
      .eq("property_id", propertyId)
      .eq("usdot_number", usdotNumber)
      .is("exited_at", null)
      .limit(1);
    if (error) throw error;
    if ((data ?? [])[0]) return data![0] as OpenSessionRow;
  }
  if (mcNumber) {
    const { data, error } = await db
      .from("plate_sessions")
      .select("id,property_id,normalized_plate,plate_text,state,entered_at,last_detected_at,visitor_pass_id,resident_plate_id,violation_id")
      .eq("property_id", propertyId)
      .eq("mc_number", mcNumber)
      .is("exited_at", null)
      .limit(1);
    if (error) throw error;
    if ((data ?? [])[0]) return data![0] as OpenSessionRow;
  }

  // Fuzzy match by RECENT PLATE-EVENT ACTIVITY, not by session entry time.
  // Activity-window = every new frame refreshes its own session's eligibility.
  //
  // Also determines per-session "anchored" status from the same query: a
  // session with ≥3 detections at ≥0.9 confidence gets wider matching
  // tolerance (anchored=true in plateSimilar). Anchored sessions absorb
  // OCR drift liberally because we're statistically certain of the plate.
  const cutoffIso = new Date(Date.now() - withinSeconds * 1000).toISOString();
  const { data: recentEvents, error: evErr } = await db
    .from("plate_events")
    .select("session_id, normalized_plate, confidence, created_at")
    .eq("property_id", propertyId)
    .gte("created_at", cutoffIso)
    .not("session_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (evErr) throw evErr;

  // Bucket events by session_id: distinct plates + count hi-conf detections.
  type Bucket = { plates: Set<string>; hiConfCount: number };
  const perSession = new Map<string, Bucket>();
  for (const ev of recentEvents ?? []) {
    if (!ev.session_id) continue;
    let b = perSession.get(ev.session_id);
    if (!b) { b = { plates: new Set(), hiConfCount: 0 }; perSession.set(ev.session_id, b); }
    if (ev.normalized_plate) b.plates.add(ev.normalized_plate);
    if (typeof ev.confidence === "number" && ev.confidence >= 0.9) b.hiConfCount++;
  }

  const candidateIds = new Set<string>();
  for (const [sessionId, bucket] of perSession) {
    const anchored = bucket.hiConfCount >= 3;
    for (const plate of bucket.plates) {
      if (plateSimilar(plate, normalizedPlate, anchored)) {
        candidateIds.add(sessionId);
        break;
      }
    }
  }
  if (candidateIds.size === 0) return null;

  const { data: openRows, error: sErr } = await db
    .from("plate_sessions")
    .select("id,property_id,normalized_plate,plate_text,state,entered_at,last_detected_at,visitor_pass_id,resident_plate_id,violation_id")
    .in("id", Array.from(candidateIds))
    .is("exited_at", null)
    .order("entered_at", { ascending: false })
    .limit(1);
  if (sErr) throw sErr;
  return ((openRows ?? [])[0] as OpenSessionRow) ?? null;
}

// Extract a pure DOT or MC number from a synthesized plate like "DOT-1234567"
// or "MC-789012". Returns null if the plate is a real license plate (no
// prefix).
function extractFmcsaNumber(normalizedPlate: string): { kind: "dot" | "mc"; number: string } | null {
  // normalizedPlate is already uppercase-alphanumeric-only via normalizePlate,
  // so "DOT-1234567" becomes "DOT1234567". We also accept the raw form.
  const dotM = normalizedPlate.match(/^DOT(\d{5,8})$/);
  if (dotM) return { kind: "dot", number: dotM[1] };
  const mcM = normalizedPlate.match(/^MC(\d{5,8})$/);
  if (mcM) return { kind: "mc", number: mcM[1] };
  return null;
}

// Pre-PR camera-anchored dedup. Returns the most recent open session whose
// entry was on this camera and whose last detection was within `withinSeconds`.
// Used to suppress redundant PR calls on a parked vehicle: once one frame
// produced a session, the next N frames from the same camera within the
// cooldown window inherit onto it instead of paying for another PR call.
export async function findRecentSessionByCamera(
  db: SupabaseClient,
  cameraId: string,
  withinSeconds: number,
): Promise<OpenSessionRow | null> {
  const cutoffIso = new Date(Date.now() - withinSeconds * 1000).toISOString();
  const { data, error } = await db
    .from("plate_sessions")
    .select("id,property_id,normalized_plate,plate_text,state,entered_at,last_detected_at,visitor_pass_id,resident_plate_id,violation_id")
    .eq("entry_camera_id", cameraId)
    .is("exited_at", null)
    .gte("last_detected_at", cutoffIso)
    .order("last_detected_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data ?? [])[0] ?? null;
}

// Per-(camera, plate) PR lock. Returns the most recent plate_events row from
// THIS camera within `withinSeconds` whose raw_data has a real PR response
// AND whose normalized_plate fuzzy-matches the sidecar's candidate read.
//
// Used to suppress new PR calls when this camera already paid for a PR
// confirmation of (a fuzzy-matching) plate recently. The lock is fixed
// window from PR's response: 3 min default (PR_LOCK_SECONDS).
//
// Cross-camera independence: this function only looks at the given camera_id.
// Camera B has its own independent lock for the same plate.
export type RecentPrCall = {
  session_id: string | null;
  plate_text: string;
  normalized_plate: string;
  created_at: string;
};
export async function findRecentPrCallForCamera(
  db: SupabaseClient,
  cameraId: string,
  candidateNormalizedPlate: string,
  withinSeconds: number,
): Promise<RecentPrCall | null> {
  if (!candidateNormalizedPlate) return null;
  const cutoffIso = new Date(Date.now() - withinSeconds * 1000).toISOString();
  // Pull recent events from this camera. Plate column-filter is best-effort
  // — fuzzy match below is the real filter. Limit 30 covers the worst-case
  // 3-min window even with high frame rate.
  const { data, error } = await db
    .from("plate_events")
    .select("session_id, plate_text, normalized_plate, created_at, raw_data")
    .eq("camera_id", cameraId)
    .gte("created_at", cutoffIso)
    .not("normalized_plate", "is", null)
    .neq("normalized_plate", "")
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw error;
  if (!data) return null;
  for (const ev of data) {
    // Only consider events that were ACTUAL PR calls — raw_data._pr_response
    // is set by the PR-success branch in camera-snapshot. Inherits and
    // suppressions don't have it, so they don't reset the lock.
    const rd = ev.raw_data as { _pr_response?: unknown } | null;
    if (!rd?._pr_response) continue;
    // anchored=true gives wider tolerance (≤2 char edits + OCR confusion
    // pairs). PR's read is high-confidence and we want to absorb sidecar
    // misreads aggressively here — false-merge risk is bounded by the
    // 3-min window (resets after).
    if (plateSimilar(ev.normalized_plate as string, candidateNormalizedPlate, true)) {
      return {
        session_id: (ev.session_id as string | null) ?? null,
        plate_text: ev.plate_text as string,
        normalized_plate: ev.normalized_plate as string,
        created_at: ev.created_at as string,
      };
    }
  }
  return null;
}

export type ResidentRow = {
  id: string;
  // The OTHER plate in the registration pair (the side the camera DIDN'T
  // read this time). Null when the registration has only one plate. Used
  // by the caller to populate plate_sessions.back_plate so future cooldown
  // queries match either side of the pair.
  paired_plate: string | null;
  normalized_paired_plate: string | null;
};
export async function findActiveResident(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
): Promise<ResidentRow | null> {
  const fmcsa = extractFmcsaNumber(normalizedPlate);

  // DOT/MC path: match resident_plates by usdot_number / mc_number instead of
  // plate_text. This is how a truck plaza employee driving a plateless
  // tractor gets allowlisted — they register with USDOT, and the camera's
  // synthesized DOT-xxx plate matches back to their resident row.
  if (fmcsa) {
    const col = fmcsa.kind === "dot" ? "usdot_number" : "mc_number";
    const { data, error } = await db
      .from("resident_plates")
      .select("id")
      .eq("property_id", propertyId)
      .eq("active", true)
      .eq(col, fmcsa.number)
      .limit(1);
    if (error) throw error;
    return (data ?? [])[0]
      ? { id: data![0].id, paired_plate: null, normalized_paired_plate: null }
      : null;
  }

  // Standard plate path. Match against EITHER front plate (plate_text) or
  // back plate (back_plate) — drivers register both since tractor + trailer
  // can show different plates depending on which way they're facing the camera.
  const { data, error } = await db
    .from("resident_plates")
    .select("id,plate_text,back_plate,active,property_id")
    .eq("property_id", propertyId)
    .eq("active", true)
    .limit(200);
  if (error) throw error;
  type Row = { id: string; plate_text?: string | null; back_plate?: string | null };
  return matchPairedRow<Row, { id: string }>(
    (data ?? []) as Row[],
    normalizedPlate,
    (r) => ({ id: r.id }),
  );
}

export type PassRow = {
  id: string;
  valid_until: string;
  // Same semantics as ResidentRow.paired_plate.
  paired_plate: string | null;
  normalized_paired_plate: string | null;
};
export async function findActiveVisitorPass(
  db: SupabaseClient,
  propertyId: string,
  normalizedPlate: string,
  now: Date,
): Promise<PassRow | null> {
  const fmcsa = extractFmcsaNumber(normalizedPlate);

  // DOT/MC path: visitor_passes.usdot_number or .mc_number.
  if (fmcsa) {
    const col = fmcsa.kind === "dot" ? "usdot_number" : "mc_number";
    const { data, error } = await db
      .from("visitor_passes")
      .select("id,valid_from,valid_until,cancelled_at")
      .eq("property_id", propertyId)
      .eq(col, fmcsa.number)
      .is("cancelled_at", null)
      .limit(10);
    if (error) throw error;
    for (const r of data ?? []) {
      if (r.valid_from && new Date(r.valid_from) > now) continue;
      if (!r.valid_until || new Date(r.valid_until) <= now) continue;
      return { id: r.id, valid_until: r.valid_until, paired_plate: null, normalized_paired_plate: null };
    }
    return null;
  }

  // Standard plate path. Match against EITHER front or back plate — drivers
  // register both at QR-checkin (tractor + trailer plates often differ).
  const { data, error } = await db
    .from("visitor_passes")
    .select("id,plate_text,back_plate,valid_from,valid_until,cancelled_at,property_id")
    .eq("property_id", propertyId)
    .limit(500);
  if (error) throw error;
  type Row = {
    id: string;
    valid_until: string;
    valid_from?: string | null;
    cancelled_at?: string | null;
    plate_text?: string | null;
    back_plate?: string | null;
  };
  const valid = ((data ?? []) as Row[]).filter((r) => {
    if (r.cancelled_at) return false;
    if (r.valid_from && new Date(r.valid_from) > now) return false;
    if (!r.valid_until || new Date(r.valid_until) <= now) return false;
    return true;
  });
  return matchPairedRow<Row, { id: string; valid_until: string }>(
    valid,
    normalizedPlate,
    (r) => ({ id: r.id, valid_until: r.valid_until }),
  );
}

/**
 * Three-pass matcher (exact → fuzzy → partial) over a list of rows that each
 * have plate_text + back_plate columns. Returns the first hit, attaching the
 * "paired" plate (the side that DIDN'T match — i.e. the side the camera
 * didn't read this entry) so the caller can stamp it onto plate_sessions for
 * future cooldown lookups.
 *
 * The two-pass exact-first ordering matters: co-registered plates that
 * collide under OCR-confusion fuzziness (e.g. ABC123 + ABG123 with C↔G)
 * must not wrong-link a clean read of one to the other's row.
 */
function matchPairedRow<
  R extends { plate_text?: string | null; back_plate?: string | null },
  B extends { id: string },
>(
  rows: R[],
  normalizedPlate: string,
  pickBase: (r: R) => B,
): (B & { paired_plate: string | null; normalized_paired_plate: string | null }) | null {
  type Cand = { front: string | null; back: string | null };
  const cand = (r: R): Cand => ({
    front: r.plate_text ? normalizePlate(r.plate_text) : null,
    back: r.back_plate ? normalizePlate(r.back_plate) : null,
  });

  // Decide which side matched, then return the OTHER side raw.
  const pair = (r: R, matchedFront: boolean) => {
    const other = matchedFront ? r.back_plate : r.plate_text;
    return {
      paired_plate: other ?? null,
      normalized_paired_plate: other ? normalizePlate(other) : null,
    };
  };

  const test = (
    pred: (a: string, b: string) => boolean,
  ): (B & { paired_plate: string | null; normalized_paired_plate: string | null }) | null => {
    for (const r of rows) {
      const c = cand(r);
      const frontHit = c.front !== null && pred(c.front, normalizedPlate);
      if (frontHit) return { ...pickBase(r), ...pair(r, true) };
      const backHit = c.back !== null && pred(c.back, normalizedPlate);
      if (backHit) return { ...pickBase(r), ...pair(r, false) };
    }
    return null;
  };

  return (
    test((a, b) => a === b) ??
    test((a, b) => plateSimilar(a, b, true)) ??
    test((a, b) => plateMatchesPartial(b, a))
  );
}

export type NewSessionInput = {
  propertyId: string;
  normalizedPlate: string;
  plateText: string;
  // Pair plate (the OTHER side — front if normalizedPlate is back, back if
  // normalizedPlate is front). Pulled from the matched pass/resident row
  // so that cooldown queries can match either plate on re-entry attempts.
  backPlate?: string | null;
  normalizedBackPlate?: string | null;
  vehicleType: string | null;
  entryCameraId: string;
  entryPlateEventId: string;
  state: "grace" | "registered" | "resident" | "expired";
  visitorPassId?: string | null;
  residentPlateId?: string | null;
  usdotNumber?: string | null;
  mcNumber?: string | null;
  enteredAt: Date;
};

export async function insertSession(
  db: SupabaseClient,
  input: NewSessionInput,
): Promise<{ id: string }> {
  const row = {
    property_id: input.propertyId,
    normalized_plate: input.normalizedPlate,
    plate_text: input.plateText,
    back_plate: input.backPlate ?? null,
    normalized_back_plate: input.normalizedBackPlate ?? null,
    vehicle_type: input.vehicleType,
    entry_camera_id: input.entryCameraId,
    entry_plate_event_id: input.entryPlateEventId,
    entered_at: input.enteredAt.toISOString(),
    state: input.state,
    visitor_pass_id: input.visitorPassId ?? null,
    resident_plate_id: input.residentPlateId ?? null,
    usdot_number: input.usdotNumber ?? null,
    mc_number: input.mcNumber ?? null,
  };
  const { data, error } = await db
    .from("plate_sessions")
    .insert(row)
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id };
}

export type ExitOutcome =
  | { kind: "closed_clean" }
  | { kind: "closed_early"; visitorPassId: string; holdUntil: Date }
  | { kind: "closed_post_violation"; violationId: string; leftBeforeTow: boolean };

export type ExitCloseInput = {
  session: OpenSessionRow;
  exitCameraId: string;
  exitPlateEventId: string;
  exitedAt: Date;
  holdDurationHours: number; // 24 for now; kept configurable for tests
};

/**
 * Decide the new state + side effects based on the open session's current
 * state. Pure: returns what should happen. The caller performs the writes.
 */
export function decideExitOutcome(
  session: OpenSessionRow,
  passValidUntil: Date | null,
  exitedAt: Date,
  holdDurationHours: number,
): ExitOutcome {
  if (session.state === "registered" && passValidUntil && passValidUntil > exitedAt && session.visitor_pass_id) {
    const holdUntil = new Date(exitedAt.getTime() + holdDurationHours * 3600 * 1000);
    return { kind: "closed_early", visitorPassId: session.visitor_pass_id, holdUntil };
  }
  if (session.state === "expired" && session.violation_id) {
    return { kind: "closed_post_violation", violationId: session.violation_id, leftBeforeTow: true };
  }
  return { kind: "closed_clean" };
}

export async function applyExitOutcome(
  db: SupabaseClient,
  input: ExitCloseInput,
  outcome: ExitOutcome,
): Promise<void> {
  const nowIso = input.exitedAt.toISOString();

  let newState: "closed_clean" | "closed_early" | "closed_post_violation";
  switch (outcome.kind) {
    case "closed_early":
      newState = "closed_early";
      break;
    case "closed_post_violation":
      newState = "closed_post_violation";
      break;
    default:
      newState = "closed_clean";
  }

  const sessionUpdate = await db
    .from("plate_sessions")
    .update({
      state: newState,
      exited_at: nowIso,
      exit_camera_id: input.exitCameraId,
      exit_plate_event_id: input.exitPlateEventId,
      updated_at: nowIso,
    })
    .eq("id", input.session.id);
  if (sessionUpdate.error) throw sessionUpdate.error;

  if (outcome.kind === "closed_early") {
    const cancelPass = await db
      .from("visitor_passes")
      .update({ cancelled_at: nowIso, cancelled_by: "exited_early" })
      .eq("id", outcome.visitorPassId);
    if (cancelPass.error) throw cancelPass.error;

    const holdInsert = await db
      .from("plate_holds")
      .insert({
        property_id: input.session.property_id,
        normalized_plate: input.session.normalized_plate,
        source_session_id: input.session.id,
        held_at: nowIso,
        hold_until: outcome.holdUntil.toISOString(),
        reason: "early_exit",
      });
    if (holdInsert.error) throw holdInsert.error;
  }

  if (outcome.kind === "closed_post_violation" && outcome.leftBeforeTow) {
    // Only flag if tow_confirmed_at is still null. Check & set atomically.
    const update = await db
      .from("alpr_violations")
      .update({ left_before_tow_at: nowIso })
      .eq("id", outcome.violationId)
      .is("tow_confirmed_at", null);
    if (update.error) throw update.error;
  }
}
