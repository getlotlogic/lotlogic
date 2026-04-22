import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { makeR2Uploader } from "../pr-ingest/r2.ts";
import { normalizePlate } from "../pr-ingest/normalize.ts";
import { extractFromRequest } from "./extract.ts";
import { parsePath } from "./path.ts";
import { findOpenSession, findSimilarOpenSession, findActiveResident, findActiveVisitorPass, insertSession, decideExitOutcome, applyExitOutcome } from "./sessions.ts";
import { isPlateHeld } from "./holds.ts";
import { extractUsdot } from "./usdot-ocr.ts";

const URL_SECRET = Deno.env.get("CAMERA_SNAPSHOT_URL_SECRET") ?? Deno.env.get("PR_INGEST_URL_SECRET") ?? "";
const PR_TOKEN = Deno.env.get("PLATE_RECOGNIZER_TOKEN") ?? "";
const PR_MIN_SCORE = Number(Deno.env.get("PR_MIN_SCORE") ?? "0.8");
// Reject PR reads shorter than this many alphanumeric chars. Two- or three-
// character "HH" / "AB" reads are partial captures, not plates, and produce
// bogus violations. 4 is the floor for every US plate format we care about.
const PR_MIN_PLATE_LEN = Number(Deno.env.get("PR_MIN_PLATE_LEN") ?? "5");
// Layer 1: require a vehicle detection with at least this score. Rejects
// plate-shaped text (trailer numbers, police unit numbers, URLs, decals)
// that PR OCRs without actually seeing a vehicle around the plate.
const REQUIRE_VEHICLE_SCORE = Number(Deno.env.get("REQUIRE_VEHICLE_SCORE") ?? "0.7");
// Tier 3 inherit-from-recent: if THIS camera produced a plate_event with a
// session in the last INHERIT_WINDOW_SECONDS, skip the PR call and inherit
// the plate + session from the recent event. Cuts PR calls for same-truck-
// in-frame bursts (Milesight fires ~1/sec while a vehicle is in view).
const INHERIT_WINDOW_SECONDS = Number(Deno.env.get("INHERIT_WINDOW_SECONDS") ?? "5");
// Direction inference: if a plate is detected on camera B within this
// window after being detected on camera A (different position_order), we
// infer direction of travel. Entries → no action. Exits → set session's
// exit_hinted_at so cron closes it on a short buffer instead of the
// default 2h buffer.
const DIRECTION_WINDOW_SECONDS = Number(Deno.env.get("DIRECTION_WINDOW_SECONDS") ?? "30");
// Silence-gap exit signal. For flanking entrances where position_order
// can't disambiguate direction, detection on an open registered session
// after this much idle time is treated as the truck passing through the
// throat again — i.e. exiting. Entrance cameras only fire at throats, so
// a large gap between events means the vehicle left the camera zone to
// park and has now returned to the throat.
const SESSION_IDLE_MINUTES = Number(Deno.env.get("SESSION_IDLE_MINUTES") ?? "5");
const USDOT_TOKEN = Deno.env.get("PARKPOW_USDOT_TOKEN") ?? "";
const USDOT_ENABLED = (Deno.env.get("ENABLE_USDOT_FALLBACK") ?? "false").toLowerCase() === "true";
const USDOT_MIN_SCORE = Number(Deno.env.get("USDOT_MIN_SCORE") ?? "0.70");
// Burst mode: when a no-plate / short-plate frame triggers OCR, keep OCR
// firing for this many seconds on this camera regardless of subsequent PR
// results. Gives the DOT reader multiple angles on the same vehicle.
const USDOT_BURST_SECONDS = Number(Deno.env.get("USDOT_BURST_SECONDS") ?? "10");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID")!;
const R2_BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME") ?? "parking-snapshots";
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID")!;
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY")!;
const R2_PUBLIC_BASE_URL = Deno.env.get("R2_PUBLIC_BASE_URL")!;

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const r2 = makeR2Uploader({
  accountId: R2_ACCOUNT_ID,
  bucket: R2_BUCKET_NAME,
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  publicBaseUrl: R2_PUBLIC_BASE_URL,
});

Deno.serve(async (req: Request) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return json(200, { ok: true, fn: "camera-snapshot", accepts: "POST image/json/multipart" });
  }
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const { apiKey: pathApiKey, secret } = parsePath(new URL(req.url));
  if (!URL_SECRET || secret !== URL_SECRET) return json(401, { ok: false, error: "unauthorized" });

  try {
    const extracted = await extractFromRequest(req);
    if (!extracted) return json(200, { ok: false, reason: "no_image_bytes" });

    // Identify the camera. Path segment wins; otherwise fall back to whatever
    // the camera self-identifies as in the payload (Milesight → devMac).
    const cameraApiKey = pathApiKey ?? extracted.cameraHint;
    if (!cameraApiKey) return json(200, { ok: false, reason: "no_camera_identity" });

    const cameraQ = await db
      .from("alpr_cameras")
      .select("id,property_id,api_key,active,orientation,usdot_active_until,position_order")
      .eq("api_key", cameraApiKey)
      .eq("active", true)
      .limit(1);
    if (cameraQ.error) throw cameraQ.error;
    const camera = (cameraQ.data ?? [])[0];
    if (!camera) return json(200, { ok: false, reason: "unknown_camera", api_key: cameraApiKey });

    // Call PR first. Only call USDOT when PR returned NO plate — i.e. the
    // camera angle didn't catch the plate. When PR sees a plate at all (even
    // at lowish confidence), we trust that read and skip the ParkPow call.
    // ── Tier 3 inherit-from-recent (PR cost reduction) ─────────────────
    // If THIS camera just produced a plate_event with an active session,
    // skip the PR API call and inherit the plate from that recent event.
    // A truck sitting in frame triggers ~1 POST/sec on Milesight; without
    // this guard, every frame = 1 PR call. With it, one PR call covers
    // the whole time the truck is in view.
    const inheritCutoff = new Date(Date.now() - INHERIT_WINDOW_SECONDS * 1000).toISOString();
    const recentQuery = await db
      .from("plate_events")
      .select("session_id, plate_text, normalized_plate, usdot_number, mc_number, confidence, plate_sessions!inner(id, state, exited_at)")
      .eq("camera_id", camera.id)
      .gt("created_at", inheritCutoff)
      .not("session_id", "is", null)
      .is("plate_sessions.exited_at", null)
      .order("created_at", { ascending: false })
      .limit(1);
    const recent = (recentQuery.data ?? [])[0] as
      | { session_id: string; plate_text: string; normalized_plate: string; usdot_number: string | null; mc_number: string | null; confidence: number }
      | undefined;

    if (recent && recent.session_id) {
      // Upload the image for evidence, skip PR, write an inherited plate_event.
      const nowDate = new Date();
      const epochMs = nowDate.getTime();
      const dateStr = nowDate.toISOString().slice(0, 10);
      const key = `${camera.property_id}/${dateStr}/${camera.api_key}-${epochMs}-${recent.plate_text}-inherited.jpg`;
      let imageUrl: string | null = null;
      let imageError: string | null = null;
      const upRes = await r2(key, extracted.bytes);
      if (upRes.ok) imageUrl = upRes.url;
      else imageError = upRes.error;

      const ev = await db.from("plate_events").insert({
        camera_id: camera.id,
        property_id: camera.property_id,
        plate_text: recent.plate_text,
        normalized_plate: recent.normalized_plate,
        confidence: recent.confidence,
        image_url: imageUrl,
        event_type: "entry",
        usdot_number: recent.usdot_number,
        mc_number: recent.mc_number,
        raw_data: {
          _source: `camera-snapshot:${extracted.source}:inherited`,
          _inherited_from_session: recent.session_id,
          ...(extracted.rawMeta ?? {}),
          ...(imageError ? { image_upload_error: imageError } : {}),
        },
        match_status: "dedup_suppressed",
        match_reason: `inherited from prior detection within ${INHERIT_WINDOW_SECONDS}s`,
        matched_at: nowDate.toISOString(),
        session_id: recent.session_id,
      });
      if (ev.error) throw ev.error;

      // Direction inference MUST run before the last_detected_at bump so the
      // silence-gap branch inside inferDirection sees the prior timestamp.
      await inferDirection(db, recent.session_id, camera.property_id, recent.normalized_plate, camera.id, camera.position_order ?? null, nowDate);

      // Bump session activity timestamp.
      await db.from("plate_sessions")
        .update({ last_detected_at: nowDate.toISOString() })
        .eq("id", recent.session_id);

      return json(200, {
        ok: true,
        events: 1,
        source: extracted.source,
        inherited: true,
        session_id: recent.session_id,
        plate_text: recent.plate_text,
      });
    }

    const prResp = await callPlateRecognizer(extracted.bytes, cameraApiKey);
    if (!prResp.ok) {
      console.warn("camera-snapshot PR call failed:", prResp.status, prResp.bodyText.slice(0, 200));
      return json(200, { ok: false, reason: "pr_call_failed", status: prResp.status });
    }

    const results = Array.isArray(prResp.data?.results) ? prResp.data.results : [];
    // Three-layer plate plausibility filter. See isPlausiblePlate() at the
    // bottom of this file: requires (1) a vehicle detection alongside the
    // plate, (2) plate-shape validation (letter+digit mix, length 5-8),
    // and (3) length-scaled confidence thresholds. Rejects trailer IDs,
    // police unit numbers, URLs, decals, and industrial labels that PR
    // OCRs as plate-shaped text.
    let surviving = results.filter((r: PrResult) => isPlausiblePlate(r));

    // Burst mode: if a recent frame had no usable plate, usdot_active_until
    // is set N seconds in the future. While that window is open, fire OCR
    // on every frame regardless of PR result — the vehicle is moving and
    // later frames may show the DOT at a better angle.
    const nowMs = Date.now();
    const burstActive = !!camera.usdot_active_until &&
      new Date(camera.usdot_active_until).getTime() > nowMs;
    const noUsablePlate = surviving.length === 0;

    const shouldCallUsdot = (USDOT_ENABLED && !!USDOT_TOKEN) &&
      (noUsablePlate || burstActive);

    const usdotResult = shouldCallUsdot
      ? await extractUsdot(extracted.bytes, { token: USDOT_TOKEN, minScore: USDOT_MIN_SCORE, cameraId: cameraApiKey })
      : { kind: "none" as const };

    // Extend or clear the burst window. A no-plate frame extends the window
    // another USDOT_BURST_SECONDS; a clean plate frame with no active burst
    // does nothing. We fire this as a fire-and-forget update — the main
    // flow continues regardless of whether it lands.
    if (shouldCallUsdot && noUsablePlate) {
      const until = new Date(nowMs + USDOT_BURST_SECONDS * 1000).toISOString();
      db.from("alpr_cameras").update({ usdot_active_until: until }).eq("id", camera.id)
        .then(({ error }) => { if (error) console.warn("usdot_active_until update failed:", error.message); });
    }

    const frameUsdot = usdotResult.kind === "dot" ? usdotResult.number : null;
    const frameMc    = usdotResult.kind === "mc"  ? usdotResult.number : null;
    let usdotSynthesizedPlate = false;

    // If PR returned nothing but ParkPow found a DOT/MC, synthesize a plate
    // row so the state machine still runs. This preserves the plateless-
    // tractor flow from before.
    if (surviving.length === 0 && usdotResult.kind !== "none") {
      surviving = [{
        plate: usdotResult.plate,
        score: usdotResult.raw_score,
        _synthesized_from: usdotResult.kind,
        _synthesized_raw_text: usdotResult.raw_text,
      }];
      usdotSynthesizedPlate = true;
      console.log(`usdot-ocr synthesized plate: kind=${usdotResult.kind} plate=${usdotResult.plate} score=${usdotResult.raw_score}`);
    }

    if (surviving.length === 0) {
      return json(200, {
        ok: true,
        events: 0,
        reason: "all_below_threshold",
        pr_results: results.length,
        usdot_called: USDOT_ENABLED && !!USDOT_TOKEN,
        usdot_found: usdotResult.kind !== "none",
      });
    }

    let eventCount = 0;
    let violationCount = 0;  // Always 0 in the new model; cron creates violations now.
    let dedupCount = 0;
    const now = new Date();

    for (const result of surviving) {
      const plateUpper = (result.plate as string).toUpperCase();
      const normalized = normalizePlate(result.plate as string);
      const vehicleType = (result as { vehicle?: { type?: string | null } }).vehicle?.type ?? null;

      // Upload the snapshot to R2 once per surviving result. Key is
      // property / day / camera / epoch / plate so evidence is easy to find.
      const epochMs = now.getTime();
      const dateStr = now.toISOString().slice(0, 10);
      const key = `${camera.property_id}/${dateStr}/${camera.api_key}-${epochMs}-${plateUpper}.jpg`;
      let imageUrl: string | null = null;
      let imageError: string | null = null;
      const upRes = await r2(key, extracted.bytes);
      if (upRes.ok) imageUrl = upRes.url;
      else imageError = upRes.error;

      const baseEventRow = (sessionId: string | null, matchStatus: string) => ({
        camera_id: camera.id,
        property_id: camera.property_id,
        plate_text: plateUpper,
        normalized_plate: normalized,
        confidence: result.score,
        image_url: imageUrl,
        event_type: camera.orientation === "exit" ? "exit" : "entry",
        // USDOT/MC from ParkPow on the same frame — attached regardless of
        // whether PR also returned a plate. Null when ParkPow found nothing
        // or synthesized this plate itself (in which case plate_text already
        // encodes DOT-xxx and usdot_number stores the bare digits).
        usdot_number: usdotSynthesizedPlate
          ? (usdotResult.kind === "dot" ? usdotResult.number : null)
          : frameUsdot,
        mc_number: usdotSynthesizedPlate
          ? (usdotResult.kind === "mc" ? usdotResult.number : null)
          : frameMc,
        raw_data: {
          ...result,
          _pr_response: prResp.data,
          _source: `camera-snapshot:${extracted.source}`,
          _orientation: camera.orientation,
          _usdot_ocr: usdotResult.kind === "none"
            ? null
            : { kind: usdotResult.kind, number: usdotResult.number, score: usdotResult.raw_score },
          ...(extracted.rawMeta ?? {}),
          ...(imageError ? { image_upload_error: imageError } : {}),
        },
        match_status: matchStatus,
        match_reason: null,
        matched_at: null,
        session_id: sessionId,
      });

      if (camera.orientation === "entry") {
        // --- ENTRY ---
        // Use fuzzy match so OCR drift across frames (HD4183 vs VHD4183 vs
        // HZ4183 — all the same physical truck) collapses onto one session
        // instead of spawning one session + one violation + one email per
        // misread character. Also match on USDOT/MC: frame 1 reads plate,
        // frame 2 reads DOT — both collapse onto the same session.
        const openSession = await findSimilarOpenSession(db, camera.property_id, normalized, 120, frameUsdot, frameMc);
        if (openSession) {
          // Noise: second entry with no exit. Append an event for visibility;
          // do not open a new session; do not modify existing session.
          const ev = await db.from("plate_events")
            .insert(baseEventRow(openSession.id, "unmatched"))
            .select().single();
          if (ev.error) throw ev.error;
          // Direction inference MUST run before the last_detected_at bump so
          // the silence-gap branch inside inferDirection sees the prior
          // timestamp.
          await inferDirection(db, openSession.id, camera.property_id, normalized, camera.id, camera.position_order ?? null, now);
          // Tier 3 priming: bump session activity so subsequent POSTs from
          // this camera within INHERIT_WINDOW_SECONDS skip the PR call.
          await db.from("plate_sessions")
            .update({ last_detected_at: now.toISOString() })
            .eq("id", openSession.id);
          dedupCount++;
          continue;
        }

        // Allowlist match: try the plate first, then the USDOT/MC number if
        // we have one. Either hit upgrades the session to resident/registered.
        let resident = await findActiveResident(db, camera.property_id, normalized);
        if (!resident && frameUsdot)   resident = await findActiveResident(db, camera.property_id, `DOT${frameUsdot}`);
        if (!resident && frameMc)      resident = await findActiveResident(db, camera.property_id, `MC${frameMc}`);

        let pass = resident ? null : await findActiveVisitorPass(db, camera.property_id, normalized, now);
        if (!resident && !pass && frameUsdot) pass = await findActiveVisitorPass(db, camera.property_id, `DOT${frameUsdot}`, now);
        if (!resident && !pass && frameMc)    pass = await findActiveVisitorPass(db, camera.property_id, `MC${frameMc}`, now);

        const held     = resident || pass ? false : await isPlateHeld(db, camera.property_id, normalized, now);
        const state = resident ? "resident" : pass ? "registered" : "grace";
        const matchStatus = resident ? "resident" : pass ? "visitor_pass" : "unmatched";

        // Insert plate_events first so session can reference it.
        const ev = await db.from("plate_events")
          .insert(baseEventRow(null, matchStatus))
          .select("id").single();
        if (ev.error) throw ev.error;
        eventCount++;

        const sess = await insertSession(db, {
          propertyId: camera.property_id,
          normalizedPlate: normalized,
          plateText: plateUpper,
          vehicleType,
          entryCameraId: camera.id,
          entryPlateEventId: ev.data.id,
          state,
          visitorPassId: pass?.id ?? null,
          residentPlateId: resident?.id ?? null,
          usdotNumber: usdotSynthesizedPlate && usdotResult.kind === "dot" ? usdotResult.number : frameUsdot,
          mcNumber:    usdotSynthesizedPlate && usdotResult.kind === "mc"  ? usdotResult.number : frameMc,
          enteredAt: now,
        });

        // Backfill the event with the session_id so evidence queries work.
        const backfill = await db.from("plate_events")
          .update({ session_id: sess.id })
          .eq("id", ev.data.id);
        if (backfill.error) throw backfill.error;

        // Direction inference across cameras.
        await inferDirection(db, sess.id, camera.property_id, normalized, camera.id, camera.position_order ?? null, now);

        // Note: held plates open state='grace'. The cron will issue a tow at
        // t+15m because the backend blocks registration during the hold.
        // We log the hold context in raw_data for operator visibility.
        if (held) {
          const existing = baseEventRow(sess.id, matchStatus).raw_data as Record<string, unknown>;
          await db.from("plate_events")
            .update({ raw_data: { ...existing, _on_hold: true } })
            .eq("id", ev.data.id);
        }

        // Fire-and-forget tow-confirm so partner tow-truck sightings record.
        // tow-confirm no-ops if the plate isn't in enforcement_partners.tow_truck_plates.
        dispatchTowConfirm({
          plate_event_id: ev.data.id,
          property_id: camera.property_id,
          plate_text: plateUpper,
          event_type: "entry",
          confidence: result.score,
          seen_at: now.toISOString(),
        });

        continue;
      }

      if (camera.orientation === "exit") {
        // --- EXIT ---
        const openSession = await findOpenSession(db, camera.property_id, normalized);
        if (!openSession) {
          // Stray exit. Log an event with no session; alert via raw_data.
          const ev = await db.from("plate_events")
            .insert(baseEventRow(null, "unmatched"))
            .select().single();
          if (ev.error) throw ev.error;
          console.warn(`stray exit: no open session for plate=${normalized} property=${camera.property_id}`);
          continue;
        }

        // Record the exit event first, then close the session.
        const ev = await db.from("plate_events")
          .insert(baseEventRow(openSession.id, "unmatched"))
          .select("id").single();
        if (ev.error) throw ev.error;
        eventCount++;

        // Need pass.valid_until if the session is registered to decide early-exit.
        let passValidUntil: Date | null = null;
        if (openSession.state === "registered" && openSession.visitor_pass_id) {
          const p = await db.from("visitor_passes")
            .select("valid_until")
            .eq("id", openSession.visitor_pass_id)
            .single();
          if (p.error) throw p.error;
          passValidUntil = p.data.valid_until ? new Date(p.data.valid_until) : null;
        }

        const outcome = decideExitOutcome(openSession, passValidUntil, now, 24);
        await applyExitOutcome(db, {
          session: openSession,
          exitCameraId: camera.id,
          exitPlateEventId: ev.data.id,
          exitedAt: now,
          holdDurationHours: 24,
        }, outcome);

        // Fire-and-forget tow-confirm for exit events too — an exit scan of a
        // partner tow truck's plate is the typical "tow complete" signal that
        // correlates back to open violations and sets tow_confirmed_at.
        dispatchTowConfirm({
          plate_event_id: ev.data.id,
          property_id: camera.property_id,
          plate_text: plateUpper,
          event_type: "exit",
          confidence: result.score,
          seen_at: now.toISOString(),
        });

        continue;
      }

      // Defensive: shouldn't happen because CHECK constraint allows only two values.
      console.warn(`unexpected camera.orientation=${camera.orientation}; skipping`);
    }

    return json(200, {
      ok: true,
      events: eventCount,
      violations: violationCount,  // always 0 in the new model; violations fire from cron
      dedup_suppressed: dedupCount,
      source: extracted.source,
      orientation: camera.orientation,
    });
  } catch (err) {
    console.error("camera-snapshot unhandled error:", err instanceof Error ? err.stack ?? err.message : err);
    return json(500, { ok: false, error: "internal_error" });
  }
});

async function callPlateRecognizer(
  imageBytes: Uint8Array,
  cameraId: string,
): Promise<{ ok: true; data: any } | { ok: false; status: number; bodyText: string }> {
  if (!PR_TOKEN) return { ok: false, status: 0, bodyText: "PLATE_RECOGNIZER_TOKEN missing" };
  const fd = new FormData();
  fd.append("upload", new Blob([imageBytes], { type: "image/jpeg" }), "snap.jpg");
  fd.append("camera_id", cameraId);
  const res = await fetch("https://api.platerecognizer.com/v1/plate-reader/", {
    method: "POST",
    headers: { Authorization: `Token ${PR_TOKEN}` },
    body: fd,
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return { ok: false, status: res.status, bodyText };
  }
  const data = await res.json();
  return { ok: true, data };
}

// Fire tow-confirm fire-and-forget. Errors are logged, never thrown: camera
// ingest continues to succeed even if the sighting correlation fails. Uses
// EdgeRuntime.waitUntil when available so the camera response isn't blocked.
function dispatchTowConfirm(body: {
  plate_event_id: string;
  property_id: string;
  plate_text: string;
  event_type: "entry" | "exit";
  confidence: number;
  seen_at: string;
}): void {
  const url = `${SUPABASE_URL}/functions/v1/tow-confirm`;
  const task = fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(body),
  })
    .then(async (res) => {
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        console.warn(`tow-confirm ${res.status} for ${body.plate_event_id}: ${t.slice(0, 200)}`);
      }
    })
    .catch((err) => {
      console.warn(`tow-confirm fetch failed for ${body.plate_event_id}: ${String(err)}`);
    });

  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type PrResult = {
  plate: string;
  score: number;
  vehicle?: { score?: number; type?: string; box?: unknown };
  box?: unknown;
};

// Three-layer plausibility check that rejects PR's plate-like false
// positives (trailer numbers, police unit numbers, URLs, decals, industrial
// labels). Real plates pass all three layers; text-that-isn't-a-plate fails
// one of them.
// Direction inference. Two branches, either can set exit_hinted_at:
//
// Branch 1 — cross-camera depth-pair (fast, ~seconds):
//   If this plate was detected on a DIFFERENT camera within
//   DIRECTION_WINDOW_SECONDS, compare position_order:
//     prior_order < this_order  → entering (toward interior). Do nothing.
//     prior_order > this_order  → exiting (toward street). Set exit_hinted_at.
//   Only fires when BOTH paired cameras capture the same pass. For rear-
//   plate-only trucks (most tractor-trailers in US fleets) each camera at a
//   depth pair only sees the vehicle for ONE direction of travel, so this
//   branch fires rarely. Useful bonus for 2-plated vehicles.
//
// Branch 2 — silence-gap (works everywhere, ~minutes):
//   Entrance cameras only fire at throats — parked trucks don't trigger
//   motion. So a detection on an open REGISTERED session whose
//   last_detected_at is > SESSION_IDLE_MINUTES ago means the truck just
//   crossed a throat again = exit. Topology-agnostic: works on flanking,
//   depth-pair, or single-camera setups. Primary exit signal.
//
// IMPORTANT: the caller MUST invoke this BEFORE bumping last_detected_at to
// now, or the silence-gap branch sees a zero gap and never fires.
//
// The hint is a SIGNAL, not a command — cron still decides whether to close
// the session. A wrong hint gets corrected by subsequent detections (if the
// truck keeps getting detected, cron waits). Safe to fire optimistically.
async function inferDirection(
  // deno-lint-ignore no-explicit-any
  db: any,
  sessionId: string,
  propertyId: string,
  normalizedPlate: string,
  currentCameraId: string,
  currentPositionOrder: number | null,
  now: Date,
): Promise<void> {
  const { data: session, error: sErr } = await db
    .from("plate_sessions")
    .select("state, last_detected_at, normalized_plate, usdot_number, mc_number")
    .eq("id", sessionId)
    .maybeSingle();
  if (sErr) { console.warn("inferDirection session fetch failed:", sErr.message); return; }
  if (!session) return;

  // ─── Branch 1: cross-camera depth-pair ─────────────────────────────
  if (currentPositionOrder != null) {
    const cutoff = new Date(now.getTime() - DIRECTION_WINDOW_SECONDS * 1000).toISOString();
    const { data: prior, error } = await db
      .from("plate_events")
      .select("camera_id, created_at, alpr_cameras!inner(position_order)")
      .eq("property_id", propertyId)
      .eq("normalized_plate", normalizedPlate)
      .neq("camera_id", currentCameraId)
      .gt("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) console.warn("inferDirection depth-pair query failed:", error.message);
    else {
      const first = (prior ?? [])[0];
      const priorOrder = first?.alpr_cameras?.position_order;
      if (priorOrder != null && priorOrder > currentPositionOrder) {
        const upd = await db.from("plate_sessions")
          .update({ exit_hinted_at: now.toISOString() })
          .eq("id", sessionId);
        if (upd.error) console.warn("exit_hinted_at depth-pair update failed:", upd.error.message);
        else console.log(`exit inferred (depth-pair) for session ${sessionId}: ${priorOrder} → ${currentPositionOrder}`);
        return;
      }
    }
  }

  // ─── Branch 2: silence-gap ─────────────────────────────────────────
  // Scope to registered sessions — grace sessions expire on their own
  // 15-min timer, expired sessions are closed by closeExpired cron.
  if (session.state !== "registered") return;
  if (!session.last_detected_at) return;

  // Strong-identity guard: findSimilarOpenSession attaches events to a
  // session via FUZZY plate match (Levenshtein ≤ 1, OCR confusion pairs,
  // substring with length-diff ≤ 3). Fuzzy matching is correct for dedup
  // (collapsing OCR drift of one physical truck), but DANGEROUS for
  // state mutation: a DIFFERENT truck arriving with a similar-looking
  // plate (e.g. HD4183 parked + VHD4183 entering) would silence-gap-
  // close the parked truck and drop a 24h cooldown hold it never earned.
  //
  // Require exact plate-or-USDOT/MC match before firing exit_hinted_at.
  // Fuzzy-matched events still get logged; they just don't trigger state
  // transitions on the "wrong" session. OCR-drift exits on the SAME
  // physical truck fall back to the 2h slow-path close in cron.
  const plateMatches = normalizedPlate === session.normalized_plate;
  const dotM = normalizedPlate.match(/^DOT(\d{5,8})$/);
  const mcM  = normalizedPlate.match(/^MC(\d{5,8})$/);
  const usdotMatches = !!(dotM && session.usdot_number && dotM[1] === session.usdot_number);
  const mcMatches    = !!(mcM  && session.mc_number    && mcM[1]  === session.mc_number);
  if (!plateMatches && !usdotMatches && !mcMatches) {
    console.log(`silence-gap skipped (fuzzy session match) session=${sessionId} inbound=${normalizedPlate} session_plate=${session.normalized_plate}`);
    return;
  }

  const idleCutoffMs = now.getTime() - SESSION_IDLE_MINUTES * 60 * 1000;
  if (new Date(session.last_detected_at).getTime() >= idleCutoffMs) return;

  const upd = await db.from("plate_sessions")
    .update({ exit_hinted_at: now.toISOString() })
    .eq("id", sessionId);
  if (upd.error) console.warn("exit_hinted_at silence-gap update failed:", upd.error.message);
  else {
    const gapSec = Math.round((now.getTime() - new Date(session.last_detected_at).getTime()) / 1000);
    console.log(`exit inferred (silence-gap) for session ${sessionId}: gap=${gapSec}s`);
  }
}

function isPlausiblePlate(r: PrResult): boolean {
  const normalized = normalizePlate(r.plate ?? "");

  // ─── Layer 2: plate SHAPE ──────────────────────────────────────────
  // Length 5-8 covers all US plate formats
  if (normalized.length < PR_MIN_PLATE_LEN || normalized.length > 8) return false;
  // Must have at least one letter AND one digit — rejects "8266" (trailer
  // ID) and "1199" (police unit number) which are pure-digit reads.
  if (!/[A-Z]/.test(normalized) || !/\d/.test(normalized)) return false;
  // No run of 6+ consecutive digits — real plates interleave letters+digits
  if (/\d{6,}/.test(normalized)) return false;

  // ─── Layer 1: VEHICLE must have been detected ──────────────────────
  // PR returns a vehicle object on each result when a car/truck was
  // detected around the plate. Missing or low-confidence vehicle means
  // the plate is probably background text (decal, sign, trailer label).
  const vehicleScore = typeof r.vehicle?.score === "number" ? r.vehicle.score : 0;
  if (vehicleScore < REQUIRE_VEHICLE_SCORE) return false;

  // ─── Layer 3: CONFIDENCE scales with length ────────────────────────
  // Shorter reads are riskier — require higher confidence to pass.
  const minConf = normalized.length === 5 ? 0.95
                : normalized.length === 6 ? 0.85
                : 0.80;
  if (r.score < Math.max(minConf, PR_MIN_SCORE)) return false;

  return true;
}
