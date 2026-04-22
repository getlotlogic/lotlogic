import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePlate } from "../pr-ingest/normalize.ts";

export type OpenSessionRow = {
  id: string;
  property_id: string;
  normalized_plate: string;
  plate_text: string;
  state: "grace" | "registered" | "resident" | "expired";
  entered_at: string;
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
    .select("id,property_id,normalized_plate,plate_text,state,entered_at,visitor_pass_id,resident_plate_id,violation_id")
    .eq("property_id", propertyId)
    .eq("normalized_plate", normalizedPlate)
    .is("exited_at", null)
    .limit(1);
  if (error) throw error;
  return (data ?? [])[0] ?? null;
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
const OCR_CONFUSIONS: Array<[string, string]> = [
  ["O", "0"], ["I", "1"], ["I", "L"], ["1", "L"],
  ["5", "S"], ["8", "B"], ["2", "Z"],
  ["7", "T"], ["T", "Y"], ["7", "Y"],
  ["6", "G"], ["D", "0"], ["D", "Q"], ["0", "Q"],
];

function areCharsConfusable(a: string, b: string): boolean {
  if (a === b) return true;
  for (const [x, y] of OCR_CONFUSIONS) {
    if ((a === x && b === y) || (a === y && b === x)) return true;
  }
  return false;
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
  if (Math.abs(a.length - b.length) <= 3 && (a.includes(b) || b.includes(a))) return true;

  const maxEdits = anchored ? 2 : 1;

  if (a.length === b.length) {
    let trueEdits = 0;
    for (let i = 0; i < a.length; i++) {
      if (!areCharsConfusable(a[i], b[i])) {
        trueEdits++;
        if (trueEdits > maxEdits) return false;
      }
    }
    return true;
  }

  return levenshteinBounded(a, b, maxEdits) <= maxEdits;
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
): Promise<OpenSessionRow | null> {
  const exact = await findOpenSession(db, propertyId, normalizedPlate);
  if (exact) return exact;

  // If we have a USDOT, check for an open session with that USDOT first —
  // one physical truck can read plate in one frame and DOT in another.
  if (usdotNumber) {
    const { data, error } = await db
      .from("plate_sessions")
      .select("id,property_id,normalized_plate,plate_text,state,entered_at,visitor_pass_id,resident_plate_id,violation_id")
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
      .select("id,property_id,normalized_plate,plate_text,state,entered_at,visitor_pass_id,resident_plate_id,violation_id")
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
    .select("id,property_id,normalized_plate,plate_text,state,entered_at,visitor_pass_id,resident_plate_id,violation_id")
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

export type ResidentRow = { id: string };
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
    return (data ?? [])[0] ? { id: data![0].id } : null;
  }

  // Standard plate path.
  const { data, error } = await db
    .from("resident_plates")
    .select("id,plate_text,active,property_id")
    .eq("property_id", propertyId)
    .eq("active", true)
    .limit(200);
  if (error) throw error;
  for (const r of data ?? []) {
    if (normalizePlate(r.plate_text ?? "") === normalizedPlate) return { id: r.id };
  }
  return null;
}

export type PassRow = { id: string; valid_until: string };
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
      return { id: r.id, valid_until: r.valid_until };
    }
    return null;
  }

  // Standard plate path.
  const { data, error } = await db
    .from("visitor_passes")
    .select("id,plate_text,valid_from,valid_until,cancelled_at,property_id")
    .eq("property_id", propertyId)
    .limit(500);
  if (error) throw error;
  for (const r of data ?? []) {
    if (r.cancelled_at) continue;
    if (r.valid_from && new Date(r.valid_from) > now) continue;
    if (!r.valid_until || new Date(r.valid_until) <= now) continue;
    if (normalizePlate(r.plate_text ?? "") === normalizedPlate) {
      return { id: r.id, valid_until: r.valid_until };
    }
  }
  return null;
}

export type NewSessionInput = {
  propertyId: string;
  normalizedPlate: string;
  plateText: string;
  vehicleType: string | null;
  entryCameraId: string;
  entryPlateEventId: string;
  state: "grace" | "registered" | "resident";
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
