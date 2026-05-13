import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { makeR2Uploader } from "../pr-ingest/r2.ts";
import { normalizePlate } from "../pr-ingest/normalize.ts";
import { extractFromRequest } from "./extract.ts";
import { parsePath } from "./path.ts";
import { findSimilarOpenSession, findRecentSessionByCamera, findRecentPrCallForCamera, findActiveResident, findActiveVisitorPass, insertSession, decideExitOutcome, applyExitOutcome, findCooldownPriorSession, type CooldownHit } from "./sessions.ts";
import { handleTruckPlazaExit } from "./truck_plaza_exit.ts";
import { isPlateHeld } from "./holds.ts";
import { extractUsdot } from "./usdot-ocr.ts";
import { computeImageHashes } from "./image-hash.ts";
import { rotateJpegBytes, type RotationDir } from "./image-rotate.ts";

const URL_SECRET = Deno.env.get("CAMERA_SNAPSHOT_URL_SECRET") ?? Deno.env.get("PR_INGEST_URL_SECRET") ?? "";
const PR_TOKEN = Deno.env.get("PLATE_RECOGNIZER_TOKEN") ?? "";
// Self-hosted Plate Recognizer Snapshot SDK toggle. When this env is set
// (e.g. https://parkpow-sdk.railway.app/v1/plate-reader/), camera-snapshot
// hits the local SDK instead of the paid cloud API. The SDK exposes the
// SAME endpoint shape and returns the same JSON, so callers don't need
// any other changes. Unset → falls back to the cloud API. This is the
// single feature flag for the SDK rollout — flip it on/off in Supabase
// secrets without redeploying.
const PR_SDK_URL = Deno.env.get("PR_SDK_URL") ?? "";
const PR_MIN_SCORE = Number(Deno.env.get("PR_MIN_SCORE") ?? "0.8");
// Per-camera PR_MIN_SCORE override. JSON map { "<camera_id>": <floor> }.
// When a camera_id is in the map, its plate reads bypass BOTH the
// length-scaled confidence ladder AND the vehicle-detection gate, and
// only require r.score >= floor. Used for cameras whose framing makes
// plates appear small (low pixels = lower PR confidence + lower vehicle
// score) — e.g. far-mounted gate cams. A/D stay on the strict path.
const PR_MIN_SCORE_OVERRIDES: Record<string, number> = (() => {
  try {
    const raw = Deno.env.get("PR_MIN_SCORE_OVERRIDES");
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 1) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
})();
// Reject PR reads shorter than this many alphanumeric chars. Two- or three-
// character "HH" / "AB" reads are partial captures, not plates, and produce
// bogus violations. 4 is the floor for every US plate format we care about.
const PR_MIN_PLATE_LEN = Number(Deno.env.get("PR_MIN_PLATE_LEN") ?? "5");
// Layer 1: require a vehicle detection with at least this score. Rejects
// plate-shaped text (trailer numbers, police unit numbers, URLs, decals)
// that PR OCRs without actually seeing a vehicle around the plate.
const REQUIRE_VEHICLE_SCORE = Number(Deno.env.get("REQUIRE_VEHICLE_SCORE") ?? "0.7");
// Removed 2026-04-25 (gate simplification — sidecar is the only filter):
//   INHERIT_WINDOW_SECONDS, IMAGE_HASH_WINDOW_SECONDS,
//   DHASH_SIMILARITY_THRESHOLD, DHASH_TIME_WINDOW_SECONDS,
//   PURE_BLACK_LUMA_THRESHOLD, NIGHT_LUMA_THRESHOLD.
// Their corresponding env vars on Supabase secrets can be safely
// removed — they no longer have any effect on the runtime.
// Diagnostic mode for sidecar rejections. When on, every frame the
// sidecar throws away gets uploaded to R2 + a thin plate_events row
// inserted with match_status='sidecar_rejected'. This is the only way
// to audit whether the sidecar gate is over-rejecting (i.e. tossing
// frames with real plates) — without it, rejected frames are gone
// forever. Toggle off via env once the gate is trusted.
const LOG_REJECTED = (Deno.env.get("DIAGNOSTIC_LOG_REJECTED") ?? "false").toLowerCase() === "true";
// OpenALPR sidecar on Railway — free local ALPR that runs BEFORE Plate
// Recognizer. If it reads a plate that matches an existing open session's
// plate (exact or fuzzy), we skip the PR API call entirely. Falls through
// to PR when the sidecar is empty, low-confidence, or can't be reached.
const OPENALPR_SIDECAR_URL = Deno.env.get("OPENALPR_SIDECAR_URL") ?? "";
const OPENALPR_SIDECAR_TOKEN = Deno.env.get("OPENALPR_SIDECAR_TOKEN") ?? "";
const OPENALPR_MIN_CONFIDENCE = Number(Deno.env.get("OPENALPR_MIN_CONFIDENCE") ?? "0.80");
const OPENALPR_TIMEOUT_MS = Number(Deno.env.get("OPENALPR_TIMEOUT_MS") ?? "4000");
// Per-camera rotation map. Cameras physically mounted at a 90°/180°
// rotation must have their frames rotated upright BEFORE being handed to
// Plate Recognizer or the USDOT/ParkPow OCR fallback — neither has a
// rotation parameter, and they return junk on sideways bytes. The
// sidecar has its own equivalent ROTATE_BEFORE_PROCESS env and rotates
// internally; this one runs in the edge function for the recognizers
// that don't.
// Format: "<uuid>:cw,<uuid>:ccw,<uuid>:180"
const ROTATE_BEFORE_PROCESS_MAP: Map<string, RotationDir> = new Map(
  (Deno.env.get("ROTATE_BEFORE_PROCESS") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean)
    .map((entry): [string, RotationDir] | null => {
      const [id, dir] = entry.split(":");
      if (!id || !dir) return null;
      const d = dir.toLowerCase();
      if (d !== "cw" && d !== "ccw" && d !== "180") return null;
      return [id, d as RotationDir];
    })
    .filter((e): e is [string, RotationDir] => e !== null),
);
// Direction inference: if a plate is detected on camera B within this
// window after being detected on camera A (different position_order), we
// infer direction of travel. Entries → no action. Exits → set session's
// exit_hinted_at so cron closes it on a short buffer instead of the
// default 2h buffer.
// 10 sec — Gabe's call. Tight enough that a second vehicle's motion
// event won't accidentally pair with the first vehicle's plate read.
// Adjacent gate cameras fire within seconds of one another for the same
// physical traversal; longer windows just admit noise.
const DIRECTION_WINDOW_SECONDS = Number(Deno.env.get("DIRECTION_WINDOW_SECONDS") ?? "10");
// Silence-gap exit signal. Detection on an open session after this
// much idle time is treated as the vehicle passing through the throat
// again — i.e. exiting. Entrance cameras only fire at throats, so a
// gap between events means the vehicle left the camera zone to park
// (or leave the property) and has now returned to a throat.
// Priority at multi-tenant properties is NO FALSE FLAGS — shorter is
// better because it closes more sessions cleanly before grace expiry.
// Directionality handled naturally: cross-camera events (south entry
// → north exit or vice versa) trigger this branch via the session's
// prior last_detected_at regardless of which camera fires the new
// event.
const SESSION_IDLE_MINUTES = Number(Deno.env.get("SESSION_IDLE_MINUTES") ?? "3");
const USDOT_TOKEN = Deno.env.get("PARKPOW_USDOT_TOKEN") ?? "";
const USDOT_ENABLED = (Deno.env.get("ENABLE_USDOT_FALLBACK") ?? "false").toLowerCase() === "true";
const USDOT_MIN_SCORE = Number(Deno.env.get("USDOT_MIN_SCORE") ?? "0.70");
// Burst mode: when a no-plate / short-plate frame triggers OCR, keep OCR
// firing for this many seconds on this camera regardless of subsequent PR
// results. Gives the DOT reader multiple angles on the same vehicle.
const USDOT_BURST_SECONDS = Number(Deno.env.get("USDOT_BURST_SECONDS") ?? "10");
// Pre-PR camera cooldown. If THIS camera has an open session whose last
// frame was within this many seconds, every subsequent frame inherits onto
// that session — no sidecar, no PR, no R2 upload. Stops the parked-vehicle
// PR-cost leak (one truck sitting still was costing N×$0.0024 per minute
// because each frame that the sidecar couldn't read fell through to PR,
// and post-PR session dedup only saved the database row, not the API call).
// Tunable: shorter window = tighter back-to-back-different-vehicle accuracy
// at slightly higher PR cost. Disable entirely with CAMERA_COOLDOWN_SECONDS=0.
const CAMERA_COOLDOWN_SECONDS = Number(Deno.env.get("CAMERA_COOLDOWN_SECONDS") ?? "60");
// Per-(camera, plate) PR lock. Once PR confirms plate X for camera A, we
// suppress new PR calls for fuzzy-matching plates from camera A for this
// many seconds. Cross-camera independent: camera B has its own lock for
// the same plate. Fixed window from PR's response (does NOT slide on each
// new frame) — guarantees a fresh re-confirmation every PR_LOCK_SECONDS
// while a vehicle remains in front of the camera.
const PR_LOCK_SECONDS = Number(Deno.env.get("PR_LOCK_SECONDS") ?? "180");
// Pre-PR delay. Always wait this many ms before calling PR so any in-flight
// PR call from a previous frame (parallel arrival from another camera, or
// the previous frame from THIS camera that's still mid-PR) has a chance to
// land its session row first. Then we can inherit onto it instead of
// duplicating the PR call. The recheck after the delay covers BOTH the
// parallel-arrival case (plate-anchored) and the parked-vehicle case
// (camera-anchored).
const PRE_PR_DELAY_MS = Number(Deno.env.get("PRE_PR_DELAY_MS") ?? "1500");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_TOKEN = Deno.env.get("INTERNAL_TOKEN") ?? "";
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

// Global kill switch. When SYSTEM_PAUSED=true, the function 200s immediately
// without processing — cameras keep firing HTTP pushes, but we don't touch
// the DB. Used to pause the whole pipeline overnight or during incident
// triage without going into the camera UI. Flip back to false (or unset)
// to resume.
const SYSTEM_PAUSED = (Deno.env.get("SYSTEM_PAUSED") ?? "false").toLowerCase() === "true";

Deno.serve(async (req: Request) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return json(200, { ok: true, fn: "camera-snapshot", accepts: "POST image/json/multipart", paused: SYSTEM_PAUSED });
  }
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  if (SYSTEM_PAUSED) return json(200, { ok: true, paused: true });

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
      .select("id,property_id,api_key,active,orientation,usdot_active_until,position_order,gate_id,entry_order,exit_order")
      .eq("api_key", cameraApiKey)
      .eq("active", true)
      .limit(1);
    if (cameraQ.error) throw cameraQ.error;
    const camera = (cameraQ.data ?? [])[0];
    if (!camera) return json(200, { ok: false, reason: "unknown_camera", api_key: cameraApiKey });

    // Property-type branch. Truck-plaza properties use the registration-
    // as-entrance model: visitor_passes is the source of truth for "on
    // property", cameras only detect EXITS of registered vehicles. The
    // legacy session state machine below handles all other property
    // types (currently apartments only).
    const propQ = await db
      .from("properties")
      .select("property_type")
      .eq("id", camera.property_id)
      .maybeSingle();
    if (propQ.error) throw propQ.error;
    const propertyType = (propQ.data?.property_type as string | null) ?? null;
    if (propertyType === "truck_plaza") {
      const r = await handleTruckPlazaExit({
        db,
        camera: { id: camera.id, property_id: camera.property_id, api_key: camera.api_key },
        payload: {
          bytes: extracted.bytes,
          cameraHint: extracted.cameraHint,
          onboardLpr: extracted.onboardLpr ?? null,
          rawMeta: extracted.rawMeta,
        },
        now: new Date(),
        uploadJpeg: async (bytes, key) => {
          const res = await r2(key, bytes);
          return res.ok ? res.url : null;
        },
      });
      console.log(`truck_plaza_exit camera=${camera.id} outcome=${r.outcome}`);
      return json(200, { ok: true, fn: "truck_plaza_exit", ...r });
    }

    // Tier 0 race guard removed 2026-04-25. Operator decision: the guard
    // was killing 30s of property-wide traffic every time the entry path
    // crashed mid-backfill, leaving an orphan null-session row. Trade
    // accepted: simultaneous multi-camera arrivals will incur N PR calls
    // (one per camera) until one creates a session and the others
    // inherit via Tier 5 sidecar matching. The new YOLOv9 + fast-plate-ocr
    // sidecar is reliable enough that those follow-up frames will match
    // the open session even on weak reads.
    // Compute image hashes (sha256 + dhash). Stored on plate_events for
    // forensics / future use only — no live dedup logic depends on them.
    const imageHashes = await computeImageHashes(extracted.bytes);

    // Hoisted sidecar read — available outside the sidecar block so the
    // pre-PR delay+recheck below can use it. Set when sidecar finds any
    // plate (high or low confidence) that didn't match an open session.
    let sidecarReadForRecheck: string | null = null;

    // ── Sidecar pre-filter (the only inherit path) ────────────────────
    // Two-stage plate reader. If it returns a plate that matches an
    // existing open session on this property, inherit — PR never gets
    // called. If it returns a plate with no matching open session, fall
    // through to PR (new vehicle, opens a session). If it returns no
    // plate, skip PR entirely (sidecar is trusted).
    if (OPENALPR_SIDECAR_URL) {
      const sidecar = await callOpenAlprSidecar(extracted.bytes, camera.id);
      // Cross-camera burst killer: try to match the sidecar's read against
      // an OPEN session on this property even if the read is below the
      // 0.80 confidence gate that normally protects against false positives.
      // Rationale: if the session is already open, it was anchored by a
      // confirmed PR read. A weak sidecar read (e.g. plate visible but
      // motion-blurred) that fuzzy-matches the existing open plate is far
      // more likely "same truck still here" than "different truck whose
      // plate happens to look like ours". Without this gate, simultaneous
      // multi-camera triggers of the same vehicle each cost a PR call.
      const candidatePlate = sidecar.bestPlate ?? sidecar.topReadPlate;
      const candidateConf = sidecar.bestPlate ? sidecar.bestConfidence : sidecar.topReadConfidence;
      const lowConfMatchAttempt = !sidecar.bestPlate && sidecar.topReadPlate && candidateConf >= 0.50;
      if (sidecar.ok && candidatePlate) {
        const sidecarNormalized = normalizePlate(candidatePlate);
        const sidecarSession = await findSimilarOpenSession(
          db, camera.property_id, sidecarNormalized, 600,
          null, null, imageHashes.dhash,
        );
        if (sidecarSession) {
          // Inherit. Skip R2 upload — we already have the canonical image
          // from this session's entry event; subsequent inherited frames
          // are timeline noise visually. Keep the row for state-machine
          // dwell/silence-gap logic and audit trail.
          const nowDate = new Date();
          const inheritedConfidence = Math.min(candidateConf, 0.70);
          const ev = await db.from("plate_events").insert({
            camera_id: camera.id,
            property_id: camera.property_id,
            plate_text: sidecarSession.plate_text,
            normalized_plate: sidecarSession.normalized_plate,
            confidence: inheritedConfidence,
            image_url: null,
            image_sha256: imageHashes.sha256,
            image_dhash: imageHashes.dhash,
            event_type: "entry",
            raw_data: {
              _source: `camera-snapshot:${extracted.source}:openalpr${lowConfMatchAttempt ? ":lowconf" : ""}`,
              _inherited_from_session: sidecarSession.id,
              _sidecar_plate: candidatePlate,
              _sidecar_confidence: candidateConf,
              _sidecar_processing_ms: sidecar.processingMs,
              _image_suppressed: "session_already_confirmed",
              ...(extracted.rawMeta ?? {}),
            },
            match_status: "dedup_suppressed",
            match_reason: `openalpr sidecar read "${candidatePlate}" (${candidateConf.toFixed(2)}${lowConfMatchAttempt ? ", below threshold" : ""}) matched session plate "${sidecarSession.plate_text}"`,
            matched_at: nowDate.toISOString(),
            session_id: sidecarSession.id,
          });
          if (ev.error) throw ev.error;

          await inferDirection(db, sidecarSession.id, camera.property_id, sidecarSession.normalized_plate, camera.id, nowDate);
          await db.from("plate_sessions")
            .update({ last_detected_at: nowDate.toISOString() })
            .eq("id", sidecarSession.id);

          console.log(`openalpr-sidecar inherit session=${sidecarSession.id} plate=${candidatePlate} conf=${candidateConf} lowconf=${lowConfMatchAttempt}`);
          return json(200, {
            ok: true,
            events: 1,
            source: extracted.source,
            inherited: true,
            inherit_tier: lowConfMatchAttempt ? "openalpr_lowconf" : "openalpr",
            session_id: sidecarSession.id,
            plate_text: sidecarSession.plate_text,
          });
        }
        // No matching open session. Before paying for PR, check the
        // per-(camera, plate) PR lock — if THIS camera already paid for a
        // PR confirmation of a fuzzy-matching plate within the last
        // PR_LOCK_SECONDS, suppress this call. The lock is per camera, so
        // camera B will still get its own first PR call for the same plate.
        if (PR_LOCK_SECONDS > 0) {
          const recentPr = await findRecentPrCallForCamera(db, camera.id, sidecarNormalized, PR_LOCK_SECONDS);
          if (recentPr) {
            const nowDate = new Date();
            const lockAgeS = Math.round((nowDate.getTime() - new Date(recentPr.created_at).getTime()) / 1000);
            const ev = await db.from("plate_events").insert({
              camera_id: camera.id,
              property_id: camera.property_id,
              plate_text: recentPr.plate_text,
              normalized_plate: recentPr.normalized_plate,
              confidence: 0.70,
              image_url: null,
              image_sha256: imageHashes.sha256,
              image_dhash: imageHashes.dhash,
              event_type: "entry",
              raw_data: {
                _source: `camera-snapshot:${extracted.source}:pr_lock`,
                _inherited_from_session: recentPr.session_id,
                _pr_lock_seconds: PR_LOCK_SECONDS,
                _pr_lock_age_seconds: lockAgeS,
                _sidecar_plate: candidatePlate,
                _sidecar_confidence: candidateConf,
                _image_suppressed: "session_already_confirmed",
                ...(extracted.rawMeta ?? {}),
              },
              match_status: "dedup_suppressed",
              match_reason: `pr-lock: camera confirmed "${recentPr.plate_text}" ${lockAgeS}s ago (window ${PR_LOCK_SECONDS}s)`,
              matched_at: nowDate.toISOString(),
              session_id: recentPr.session_id,
            });
            if (ev.error) throw ev.error;
            if (recentPr.session_id) {
              await db.from("plate_sessions")
                .update({ last_detected_at: nowDate.toISOString() })
                .eq("id", recentPr.session_id);
            }
            console.log(`pr-lock inherit camera=${camera.id} plate=${candidatePlate}~${recentPr.plate_text} age=${lockAgeS}s (saved a PR call)`);
            return json(200, {
              ok: true,
              events: 1,
              source: extracted.source,
              inherited: true,
              inherit_tier: "pr_lock",
              session_id: recentPr.session_id,
              plate_text: recentPr.plate_text,
            });
          }
        }
        // No matching session AND no PR lock. Save the sidecar's read so
        // the pre-PR recheck below can re-query for an open session after a
        // brief delay (handles parallel-arrival case: another camera's
        // frame for the same vehicle is still mid-PR-call).
        sidecarReadForRecheck = candidatePlate;
        if (sidecar.bestPlate) {
          console.log(`openalpr-sidecar read "${sidecar.bestPlate}" conf=${sidecar.bestConfidence} but no matching session; will recheck before PR`);
        }
        // Below-threshold reads with no session match: treat exactly like
        // no_plate (fall to the no-plate branch below).
      }
      if (sidecar.ok && !sidecar.bestPlate) {
        // Sidecar ran successfully but returned no usable plate. Three
        // sub-reasons (set by callOpenAlprSidecar based on the response):
        //
        //   • empty_scene           → zero text regions in the frame
        //   • no_plate_shaped_text  → text regions found, none passed the
        //                              plate-shape filter (signs, decals,
        //                              trailer numbers, distant cars)
        //   • below_min_confidence  → easyocr saw plate-shaped text but
        //                              wasn't confident enough; PR's
        //                              higher-quality model might catch it
        //
        // The gate is now LOOSE. easyocr is a text detector, not a plate
        // detector — its plate-shape filter rejects valid plates at angles,
        // motion blur, or unusual formats (4-char trucks, vanity plates,
        // foreign formats). Operator feedback 2026-04-24: "the filter is
        // too tight" — too many real plates being skipped.
        //
        // New behavior:
        //   • empty_scene (rawDetections === 0) → still skip PR. PR can't
        //     find what's not there. Safe to gate.
        //   • no_plate_shaped_text → SKIP PR. Operator observed many wasted
        //     PR calls on "side of cars" and "pure black" frames — those are
        //     exactly the cases where sidecar correctly returns this reason.
        //     With the looser sidecar plate-shape rules (4-10 chars, no
        //     letter+digit requirement, conf >= 0.35), real plates are now
        //     reliably classified as plate-shaped, so the no_plate_shaped
        //     verdict can be trusted as "no plate to read here."
        //   • below_min_confidence → fall through to PR (unchanged).
        //
        // Diagnostic rows still written for both skip cases so the labeling
        // UI populates. If real plates ever show up here, operator labels
        // 'real_plate' and the curator surfaces a tuning recommendation.
        // The sidecar's job is to filter ONLY obviously useless frames.
        // PR is better at judging plate vs not-plate — let it decide on
        // anything ambiguous. So we only hard-skip when:
        //   • empty_scene (sidecar saw zero text — nothing for PR to read)
        //   • pure_black is handled separately above the gate
        // Every other reason (no_plate_shaped_text, below_min_confidence)
        // falls through to PR. Cost ↑ slightly, recall ↑↑.
        const isHardSkip = sidecar.reason === "empty_scene";
        const fallThroughReason = sidecar.reason === "below_min_confidence"
          ? `below_min_confidence (${sidecar.bestConfidence.toFixed(2)})`
          : sidecar.reason ?? "no_plate";
        if (!isHardSkip) {
          console.log(`openalpr-sidecar ${fallThroughReason}, falling through to PR for confirmation`);
          // fall through to PR — do not return here
        } else {
          console.log(`openalpr-sidecar empty_scene: skipping PR (rawDetections=0)`);
          if (LOG_REJECTED) {
            // Diagnostic: capture the rejected frame so an operator (or a
            // future training pipeline) can verify whether the gate threw
            // away anything that contained a real plate. Upload + thin
            // event row, no session, no violation.
            const nowDate = new Date();
            const epochMs = nowDate.getTime();
            const dateStr = nowDate.toISOString().slice(0, 10);
            const reason = sidecar.reason ?? "no_plate";
            const key = `${camera.property_id}/${dateStr}/diag-${camera.api_key}-${epochMs}-rejected-${reason}.jpg`;
            let imageUrl: string | null = null;
            let imageError: string | null = null;
            const upRes = await r2(key, extracted.bytes);
            if (upRes.ok) imageUrl = upRes.url;
            else {
              imageError = upRes.error;
              console.error(`diagnostic R2 upload failed for ${key}: ${upRes.error}`);
            }
            const diag = await db.from("plate_events").insert({
              camera_id: camera.id,
              property_id: camera.property_id,
              plate_text: "",
              normalized_plate: "",
              confidence: 0,
              image_url: imageUrl,
              image_sha256: imageHashes.sha256,
              image_dhash: imageHashes.dhash,
              event_type: "entry",
              raw_data: {
                _source: `camera-snapshot:${extracted.source}:rejected`,
                _sidecar_reason: reason,
                _sidecar_raw_detection_count: sidecar.rawDetectionCount,
                _sidecar_best_confidence: sidecar.bestConfidence,
                ...(imageError ? { _r2_error: imageError } : {}),
                _sidecar_processing_ms: sidecar.processingMs,
                ...(extracted.rawMeta ?? {}),
              },
              match_status: "sidecar_rejected",
              match_reason: `sidecar ${reason} (rawDetections=${sidecar.rawDetectionCount})`,
              session_id: null,
            });
            // Surface insert errors loudly. The CHECK constraint that
            // initially rejected match_status='sidecar_rejected' was a
            // silent failure for hours; never again.
            if (diag.error) console.error(`diagnostic insert failed: ${diag.error.message}`);
          }
          await maybePairedMotionExitHint(db, camera, new Date());
          return json(200, {
            ok: true,
            events: 0,
            source: extracted.source,
            deduped: true,
            inherit_tier: `sidecar_${sidecar.reason ?? "no_plate"}`,
            logged: LOG_REJECTED,
          });
        }
      }
    }

    // Hash-dedup consumer block removed 2026-04-25. Sidecar's plate-match
    // against open sessions covers this case (and more) directly above.

    // ── Pre-PR delay + recheck (ALWAYS runs) ─────────────────────────
    // We're about to spend a PR API call. Before paying, hold the frame
    // briefly and re-query the DB. Two ways an in-flight PR call from a
    // previous frame could have just created a session we should inherit
    // onto:
    //
    //   A. CAMERA-ANCHORED — same camera, parked vehicle. The previous
    //      frame from THIS camera produced a session in the last
    //      CAMERA_COOLDOWN_SECONDS. Every subsequent frame collapses
    //      onto it without paying for sidecar+PR. Fixes the parked-
    //      vehicle PR-cost leak (one truck = N×$0.0024/min).
    //
    //   B. PLATE-ANCHORED — different camera (or same camera, different
    //      sidecar read), parallel arrivals. The previous frame's
    //      sidecar read this same plate. The window here is 600s
    //      because plate-text dedup is safer than camera-anchored
    //      (it requires a fuzzy plate match, so it can't false-merge
    //      different vehicles).
    //
    // Order: (A) first because it handles the common case (parked
    // vehicle) and doesn't need the sidecar to have produced a plate.
    // Then (B) only if sidecar gave us something to look up.
    const delayMs = Math.max(0, PRE_PR_DELAY_MS);
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));

    // (A) Camera-anchored: any open session whose entry was on this camera
    // AND whose last_detected_at is within the cooldown window.
    if (CAMERA_COOLDOWN_SECONDS > 0) {
      const cameraSession = await findRecentSessionByCamera(db, camera.id, CAMERA_COOLDOWN_SECONDS);
      if (cameraSession) {
        const nowDate = new Date();
        const ev = await db.from("plate_events").insert({
          camera_id: camera.id,
          property_id: camera.property_id,
          plate_text: cameraSession.plate_text,
          normalized_plate: cameraSession.normalized_plate,
          confidence: 0.70,
          image_url: null,
          image_sha256: imageHashes.sha256,
          image_dhash: imageHashes.dhash,
          event_type: "entry",
          raw_data: {
            _source: `camera-snapshot:${extracted.source}:camera_cooldown`,
            _inherited_from_session: cameraSession.id,
            _camera_cooldown_seconds: CAMERA_COOLDOWN_SECONDS,
            _sidecar_plate: sidecarReadForRecheck ?? null,
            _image_suppressed: "session_already_confirmed",
            ...(extracted.rawMeta ?? {}),
          },
          match_status: "dedup_suppressed",
          match_reason: `camera cooldown: session ${cameraSession.id.slice(0,8)} on this camera was active in last ${CAMERA_COOLDOWN_SECONDS}s`,
          matched_at: nowDate.toISOString(),
          session_id: cameraSession.id,
        });
        if (ev.error) throw ev.error;
        await db.from("plate_sessions")
          .update({ last_detected_at: nowDate.toISOString() })
          .eq("id", cameraSession.id);
        console.log(`camera-cooldown inherit session=${cameraSession.id} plate=${cameraSession.plate_text} (saved a PR call)`);
        return json(200, {
          ok: true,
          events: 1,
          source: extracted.source,
          inherited: true,
          inherit_tier: "camera_cooldown",
          session_id: cameraSession.id,
          plate_text: cameraSession.plate_text,
        });
      }
    }

    // (B) Plate-anchored: parallel-arrival across cameras. Only fires when
    // the sidecar gave us a plate to look up. Window is wider (600s) and
    // safer because plate-similarity gates the match.
    if (sidecarReadForRecheck) {
      const recheckPlate = normalizePlate(sidecarReadForRecheck);
      const recheckSession = await findSimilarOpenSession(
        db, camera.property_id, recheckPlate, 600,
        null, null, imageHashes.dhash,
      );
      if (recheckSession) {
        const nowDate = new Date();
        const ev = await db.from("plate_events").insert({
          camera_id: camera.id,
          property_id: camera.property_id,
          plate_text: recheckSession.plate_text,
          normalized_plate: recheckSession.normalized_plate,
          confidence: 0.70,
          image_url: null,
          image_sha256: imageHashes.sha256,
          image_dhash: imageHashes.dhash,
          event_type: "entry",
          raw_data: {
            _source: `camera-snapshot:${extracted.source}:pre_pr_recheck`,
            _inherited_from_session: recheckSession.id,
            _sidecar_plate: sidecarReadForRecheck,
            ...(extracted.rawMeta ?? {}),
          },
          match_status: "dedup_suppressed",
          match_reason: `pre-PR recheck: parallel frame created session for ${recheckSession.plate_text}`,
          matched_at: nowDate.toISOString(),
          session_id: recheckSession.id,
        });
        if (ev.error) throw ev.error;
        await inferDirection(db, recheckSession.id, camera.property_id, recheckSession.normalized_plate, camera.id, nowDate);
        await db.from("plate_sessions")
          .update({ last_detected_at: nowDate.toISOString() })
          .eq("id", recheckSession.id);
        console.log(`pre-PR recheck inherit session=${recheckSession.id} plate=${recheckSession.plate_text} (saved a PR call)`);
        return json(200, {
          ok: true,
          events: 1,
          source: extracted.source,
          inherited: true,
          inherit_tier: "pre_pr_recheck",
          session_id: recheckSession.id,
          plate_text: recheckSession.plate_text,
        });
      }
    }
    // Both rechecks missed — really is a new vehicle. Pay for PR.

    // For physically-rotated cameras, rotate the bytes upright BEFORE
    // handing them to PR or USDOT/ParkPow OCR. Neither service has a
    // rotation knob; on sideways bytes they return junk or nothing.
    // Sidecar has its own ROTATE_BEFORE_PROCESS and self-rotates above,
    // so this rotation only affects the downstream recognizers.
    const rotateDir = ROTATE_BEFORE_PROCESS_MAP.get(camera.id);
    const bytesForRecognizers = rotateDir
      ? await rotateJpegBytes(extracted.bytes, rotateDir)
      : extracted.bytes;
    if (rotateDir) {
      console.log(`camera-snapshot: pre-rotated bytes (${rotateDir}) for camera=${camera.id} before PR/USDOT`);
    }

    const prResp = await callPlateRecognizer(bytesForRecognizers, cameraApiKey);
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
    let surviving = results.filter((r: PrResult) => isPlausiblePlate(r, camera.id));

    // Burst mode: if a recent frame had no usable plate, usdot_active_until
    // is set N seconds in the future. USDOT OCR only fires when THIS frame
    // has no usable plate — if PR already returned a plate, we already know
    // what vehicle is here and a ParkPow call would be wasted money. The
    // burst window just means "the last frame on this camera had no plate,
    // so keep trying ParkPow on subsequent no-plate frames without waiting
    // for another grace period." It does NOT mean "call ParkPow on every
    // frame during the window" — that was the old OR behavior which doubled
    // the OCR spend every time a truck's plate wasn't readable for a beat.
    const nowMs = Date.now();
    const noUsablePlate = surviving.length === 0;

    const shouldCallUsdot = (USDOT_ENABLED && !!USDOT_TOKEN) && noUsablePlate;

    const usdotResult = shouldCallUsdot
      ? await extractUsdot(bytesForRecognizers, { token: USDOT_TOKEN, minScore: USDOT_MIN_SCORE, cameraId: cameraApiKey })
      : { kind: "none" as const };

    // Extend the burst window. A no-plate frame extends the window another
    // USDOT_BURST_SECONDS — the next frame might still be no-plate and we
    // want ParkPow to keep firing on it. shouldCallUsdot already requires
    // noUsablePlate, so this runs iff we just did a ParkPow call. Fire-
    // and-forget — the main flow continues regardless.
    if (shouldCallUsdot) {
      const until = new Date(nowMs + USDOT_BURST_SECONDS * 1000).toISOString();
      db.from("alpr_cameras").update({ usdot_active_until: until }).eq("id", camera.id)
        .then(({ error }: { error: { message: string } | null }) => { if (error) console.warn("usdot_active_until update failed:", error.message); });
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
      // PR was called but returned nothing usable. This is the silent PR-
      // cost leak: we paid for the call, the gate let it through, and now
      // there's no row to show for it. With LOG_REJECTED on, capture the
      // frame anyway so the operator can see what PR rejected and the
      // training-curator has the full picture (sidecar said "maybe plate"
      // but PR couldn't confirm it). match_status='sidecar_rejected' is
      // reused — semantically these are "system rejected the frame", and
      // the raw_data._sidecar_reason='pr_no_plate' identifies them.
      if (LOG_REJECTED) {
        const nowDate = new Date();
        const epochMs = nowDate.getTime();
        const dateStr = nowDate.toISOString().slice(0, 10);
        const key = `${camera.property_id}/${dateStr}/diag-${camera.api_key}-${epochMs}-rejected-pr_no_plate.jpg`;
        let imageUrl: string | null = null;
        let imageError: string | null = null;
        const upRes = await r2(key, extracted.bytes);
        if (upRes.ok) imageUrl = upRes.url;
        else {
          imageError = upRes.error;
          console.error(`pr-no-plate R2 upload failed for ${key}: ${upRes.error}`);
        }
        const diag = await db.from("plate_events").insert({
          camera_id: camera.id,
          property_id: camera.property_id,
          plate_text: "",
          normalized_plate: "",
          confidence: 0,
          image_url: imageUrl,
          image_sha256: imageHashes.sha256,
          image_dhash: imageHashes.dhash,
          event_type: "entry",
          raw_data: {
            _source: `camera-snapshot:${extracted.source}:rejected`,
            _sidecar_reason: "pr_no_plate",
            _pr_results_count: results.length,
            _pr_call_made: true,
            _pr_source: prResp.source,
            _usdot_called: USDOT_ENABLED && !!USDOT_TOKEN,
            _usdot_found: usdotResult.kind !== "none",
            ...(imageError ? { _r2_error: imageError } : {}),
            ...(extracted.rawMeta ?? {}),
          },
          match_status: "sidecar_rejected",
          match_reason: `PR called but no usable plate (results=${results.length})`,
          session_id: null,
        });
        if (diag.error) console.error(`pr-no-plate diagnostic insert failed: ${diag.error.message}`);
      }
      await maybePairedMotionExitHint(db, camera, new Date());
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

      // ─── Direction inference from position_order + read-pair sequence ──
      // Each gate has TWO cameras with opposite-facing lenses. They both
      // catch every transit (front and back plates), so each physical pass
      // produces two reads at the same gate within seconds. Direction comes
      // from which camera fires FIRST in the pair, scoped to position_order:
      //
      //   position_order = 1  → road-side camera (boundary)
      //   position_order = 2  → lot-side camera (interior)
      //
      //   First-of-pair at position 1  → vehicle hit boundary first → ARRIVING
      //   First-of-pair at position 2  → vehicle hit interior first → LEAVING
      //
      // The SECOND read of a pair is a confirmation, not a new event — it
      // gets logged with event_type='paired_read' and skips session state
      // mutation. This eliminates the phantom-session problem the old
      // orientation-flag model created (entry+exit firing seconds apart on
      // a single physical pass).
      //
      // Legacy fallback: if entry_order/exit_order are null (camera not
      // configured for the gate-pair model), fall back to camera.orientation.
      let isPairedRead = false;
      let direction: "entry" | "exit";
      const cameraGateId = (camera as { gate_id?: string | null }).gate_id ?? null;
      const cameraEntryOrder = (camera as { entry_order?: number | null }).entry_order ?? null;
      const cameraExitOrder  = (camera as { exit_order?:  number | null }).exit_order  ?? null;
      if (cameraEntryOrder != null || cameraExitOrder != null) {
        const cutoff = new Date(now.getTime() - DIRECTION_WINDOW_SECONDS * 1000).toISOString();
        let priorQ = db
          .from("plate_events")
          .select("camera_id, alpr_cameras!inner(gate_id, entry_order, exit_order)")
          .eq("property_id", camera.property_id)
          .neq("camera_id", camera.id)
          .gt("created_at", cutoff)
          .order("created_at", { ascending: false })
          .limit(1);
        if (cameraGateId) {
          priorQ = priorQ.eq("alpr_cameras.gate_id", cameraGateId);
        }
        const { data: priorAtGate } = await priorQ;
        const priorRow = (priorAtGate ?? [])[0];
        if (priorRow) {
          isPairedRead = true;
          // Direction comes from comparing per-direction firing order. The
          // prior fired before us; if its entry_order is lower than ours,
          // we're the second-of-pair on an entry. Same logic for exit_order.
          const priorEntryOrder = (priorRow as { alpr_cameras?: { entry_order?: number | null } })
            .alpr_cameras?.entry_order ?? null;
          const priorExitOrder  = (priorRow as { alpr_cameras?: { exit_order?:  number | null } })
            .alpr_cameras?.exit_order  ?? null;
          if (priorEntryOrder != null && cameraEntryOrder != null && priorEntryOrder < cameraEntryOrder) {
            direction = "entry";
          } else if (priorExitOrder != null && cameraExitOrder != null && priorExitOrder < cameraExitOrder) {
            direction = "exit";
          } else {
            direction = cameraEntryOrder === 1 ? "entry" : "exit";
          }
        } else {
          // Single plate-OCR read with no paired motion in the window.
          // Default to the direction this camera has order=2 in: order=2
          // means "fires second" which means "sees the back of the
          // truck", and the back is the side that produces a successful
          // OCR (rear plates are universal; front plates are not).
          // Tradeoff: a front-plate vehicle whose paired camera fails to
          // fire motion gets classified as the wrong direction. Cost is
          // a missed registration, not a false violation, so the bias
          // is correct.
          if (cameraEntryOrder === 2) direction = "entry";
          else if (cameraExitOrder === 2) direction = "exit";
          else direction = "entry";
        }
      } else {
        direction = camera.orientation === "exit" ? "exit" : "entry";
      }

      const baseEventRow = (sessionId: string | null, matchStatus: string) => ({
        camera_id: camera.id,
        property_id: camera.property_id,
        plate_text: plateUpper,
        normalized_plate: normalized,
        confidence: result.score,
        image_url: imageUrl,
        image_sha256: imageHashes.sha256,
        image_dhash: imageHashes.dhash,
        event_type: isPairedRead ? "paired_read" : direction,
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
          _pr_source: prResp.source,
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

      // Paired-read second-of-pair: log the event tied to the existing open
      // session if any, but skip session state mutation. The first-of-pair
      // already opened or closed the session. Without this guard, each
      // physical transit would fire entry+exit seconds apart and break
      // session state.
      //
      // Use findSimilarOpenSession (not findOpenSession) so OCR drift
      // between the two cameras at one gate (HD4183 vs VHD4183 vs HZ4183)
      // doesn't orphan the second-of-pair event with session_id=null.
      // Entry pair (road-side fired first, this is lot-side second-of-pair):
      // the FIRST-of-pair already created the session. Just append the event
      // and continue — no session work.
      if (isPairedRead && direction === "entry") {
        const openSession = await findSimilarOpenSession(
          db, camera.property_id, normalized, 120, frameUsdot, frameMc, imageHashes.dhash,
        );
        const ev = await db.from("plate_events")
          .insert(baseEventRow(openSession?.id ?? null, "unmatched"))
          .select("id").single();
        if (ev.error) throw ev.error;
        eventCount++;
        continue;
      }

      // Exit-pattern fall-through: if we got here with direction="exit" and
      // no open session for this plate, the truck is leaving and we never
      // saw them enter (cameras dark before, partial reads, etc.). Per
      // 2026-04-29 user direction: do NOT open a phantom grace session for
      // exits. Just log the event so the parking log shows the read, and
      // skip violation logic entirely. This was the BD87979 bug — the
      // "defensive direction flip" used to convert no-session exits into
      // entries, opening a 30-min grace clock on a truck already pulling
      // out of the lot.
      if (direction === "exit") {
        const peekSession = await findSimilarOpenSession(
          db, camera.property_id, normalized, 120, frameUsdot, frameMc, imageHashes.dhash,
        );
        if (!peekSession) {
          const ev = await db.from("plate_events")
            .insert(baseEventRow(null, "unmatched"))
            .select("id").single();
          if (ev.error) throw ev.error;
          eventCount++;
          console.log(`stray exit (no session, no flip): plate=${normalized} property=${camera.property_id}`);
          continue;
        }
      }

      if (direction === "entry") {
        // --- ENTRY ---
        // Use fuzzy match so OCR drift across frames (HD4183 vs VHD4183 vs
        // HZ4183 — all the same physical truck) collapses onto one session
        // instead of spawning one session + one violation + one email per
        // misread character. Also match on USDOT/MC: frame 1 reads plate,
        // frame 2 reads DOT — both collapse onto the same session.
        const openSession = await findSimilarOpenSession(
          db, camera.property_id, normalized, 120, frameUsdot, frameMc, imageHashes.dhash,
        );
        if (openSession) {
          // The presence model: re-reads of an open session map to either
          //   (a) DEDUP — within the 15-min dedup window, treat as continued
          //       presence, bump last_detected_at, keep session open
          //   (b) EXIT — outside the dedup window, vehicle is driving past
          //       the camera AGAIN (leaving the lot). Close the session.
          // The dedup window is keyed on last_detected_at, sliding.
          // Same-vehicle reads via the OTHER plate (front vs back) collapse
          // to the same session via vehicle_id (visitor_pass_id /
          // resident_plate_id) so plate-pair reads don't false-fire exits.
          const DEDUP_WINDOW_MS = 15 * 60 * 1000;
          const lastSeen = openSession.last_detected_at
            ? new Date(openSession.last_detected_at).getTime()
            : new Date(openSession.entered_at).getTime();
          const gap = now.getTime() - lastSeen;

          if (gap > DEDUP_WINDOW_MS) {
            // EXIT — re-pass after dedup expired. Close the session.
            const exitEv = await db.from("plate_events")
              .insert({ ...baseEventRow(openSession.id, "unmatched"), event_type: "exit" })
              .select().single();
            if (exitEv.error) throw exitEv.error;

            await db.from("plate_sessions")
              .update({
                exited_at: now.toISOString(),
                exit_camera_id: camera.id,
                exit_plate_event_id: exitEv.data.id,
                last_detected_at: now.toISOString(),
                state: openSession.state === "expired" ? "expired" : "closed_clean",
                updated_at: now.toISOString(),
              })
              .eq("id", openSession.id);

            console.log(`exit detected: session=${openSession.id} plate=${normalized} gap=${Math.round(gap/60000)}min`);
            eventCount++;
            continue;
          }

          // DEDUP — still within window. Continued presence.
          const ev = await db.from("plate_events")
            .insert(baseEventRow(openSession.id, "unmatched"))
            .select().single();
          if (ev.error) throw ev.error;
          // Direction inference MUST run before the last_detected_at bump so
          // the silence-gap branch inside inferDirection sees the prior
          // timestamp.
          await inferDirection(db, openSession.id, camera.property_id, normalized, camera.id, now);
          // Bump session activity so we extend the dedup window on next read.
          await db.from("plate_sessions")
            .update({ last_detected_at: now.toISOString() })
            .eq("id", openSession.id);
          dedupCount++;
          continue;
        }

        // Asymmetric session-opening guard. Single OCR'd reads with no
        // paired motion in the window are ambiguous in general, but the
        // ambiguity isn't symmetric across cameras:
        //
        //   - entry_order=2 cameras (C, D — lot-side, lens facing into
        //     the lot) reliably read the BACK of entering trucks. Single
        //     reads here are almost always real entries: open the session.
        //
        //   - exit_order=2 cameras (E, A — street-side, lens facing the
        //     street) reliably read the BACK of leaving trucks. Single
        //     reads here are almost always real exits — they should NOT
        //     open new sessions (otherwise we false-violate trucks that
        //     are leaving). Log only.
        //
        // Without this asymmetry, the dominant truck-plaza traffic
        // (rear-plate-only tractors) generates zero sessions because the
        // partner camera frequently misses motion or fires AFTER the OCR'd
        // read (which the backward-only priorQ doesn't catch).
        if (!isPairedRead && cameraEntryOrder !== 2) {
          const ev = await db.from("plate_events")
            .insert(baseEventRow(null, "unmatched"))
            .select("id").single();
          if (ev.error) throw ev.error;
          eventCount++;
          console.log(`single-read no-pair at exit-side cam: logged stray ${normalized} at ${camera.id} — no session opened`);
          continue;
        }

        // Allowlist match: try the plate first, then the USDOT/MC number if
        // we have one. Either hit upgrades the session to resident/registered.
        // Both lookups now check FRONT and BACK plate columns on the registered
        // row — drivers register both plates at QR check-in since tractors and
        // trailers can show different plates.
        let resident = await findActiveResident(db, camera.property_id, normalized);
        if (!resident && frameUsdot)   resident = await findActiveResident(db, camera.property_id, `DOT${frameUsdot}`);
        if (!resident && frameMc)      resident = await findActiveResident(db, camera.property_id, `MC${frameMc}`);

        let pass = resident ? null : await findActiveVisitorPass(db, camera.property_id, normalized, now);
        if (!resident && !pass && frameUsdot) pass = await findActiveVisitorPass(db, camera.property_id, `DOT${frameUsdot}`, now);
        if (!resident && !pass && frameMc)    pass = await findActiveVisitorPass(db, camera.property_id, `MC${frameMc}`, now);

        // Cooldown: a previously-REGISTERED vehicle that parked and left
        // within cooldown_hours blocks re-entry regardless of its current
        // registration status. Only checked when there's no live resident/
        // pass match (those bypass cooldown).
        const cooldown: CooldownHit | null = (resident || pass)
          ? null
          : await findCooldownPriorSession(db, camera.property_id, normalized, now);

        // Unregistered plates DO open a session — in `grace` state, giving
        // the driver 15 min to register via QR. graceExpiry in the cron sweep
        // throws the session away (closed_clean, no violation) at 15 min if
        // still unmatched. Registration in that window promotes the session
        // to `registered` via registrationTransition.
        const held     = resident || pass ? false : await isPlateHeld(db, camera.property_id, normalized, now);
        // Cooldown was already computed above (used for the ignore-unregistered
        // early-return decision). When state="expired" + matchStatus="cooldown",
        // the alpr_violations row is inserted below.
        const state = resident ? "resident" : pass ? "registered" : cooldown ? "expired" : "grace";
        const matchStatus = resident ? "resident" : pass ? "visitor_pass" : cooldown ? "cooldown" : "unmatched";

        // Insert plate_events first so session can reference it.
        const ev = await db.from("plate_events")
          .insert(baseEventRow(null, matchStatus))
          .select("id").single();
        if (ev.error) throw ev.error;
        eventCount++;

        // Wrap session creation in a try so we can roll back the orphan
        // plate_event if insertSession or backfill fails. Without this
        // cleanup, transient DB errors leave plate_events rows with
        // session_id=null forever — they pollute Training-tab queues and
        // evidence joins.
        let sess;
        try {
          // Paired plate: the OTHER side of the registration pair (the side
          // the camera didn't read this entry). Stamped onto the session so
          // future cooldown queries match either plate of the pair.
          const paired = resident ?? pass;
          sess = await insertSession(db, {
            propertyId: camera.property_id,
            normalizedPlate: normalized,
            plateText: plateUpper,
            backPlate: paired?.paired_plate ?? null,
            normalizedBackPlate: paired?.normalized_paired_plate ?? null,
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
        } catch (err) {
          await db.from("plate_events").delete().eq("id", ev.data.id);
          throw err;
        }

        // Direction inference across cameras.
        await inferDirection(db, sess.id, camera.property_id, normalized, camera.id, now);

        // Note: held plates open state='grace'. The cron will issue a tow at
        // t+15m because the backend blocks registration during the hold.
        // We log the hold context in raw_data for operator visibility.
        if (held) {
          const existing = baseEventRow(sess.id, matchStatus).raw_data as Record<string, unknown>;
          await db.from("plate_events")
            .update({ raw_data: { ...existing, _on_hold: true } })
            .eq("id", ev.data.id);
        }

        // 24h cooldown violation: the session was opened with state='expired'
        // above. Create the alpr_violations row inline so the dashboard +
        // tow-dispatch fire immediately (no waiting for cron-sessions-sweep).
        if (cooldown) {
          const vIns = await db.from("alpr_violations").insert({
            property_id: camera.property_id,
            plate_event_id: ev.data.id,
            plate_text: plateUpper,
            status: "pending",
            violation_type: "cooldown",
            session_id: sess.id,
            notes: `Re-entry within ${cooldown.cooldown_hours}h cooldown (prior exit ${cooldown.prior_exited_at})`,
          }).select("id").single();
          if (vIns.error) throw vIns.error;

          const sUpd = await db.from("plate_sessions")
            .update({ violation_id: vIns.data.id, updated_at: now.toISOString() })
            .eq("id", sess.id);
          if (sUpd.error) throw sUpd.error;

          // Stash cooldown context on the plate_event for operator visibility.
          const existing = baseEventRow(sess.id, matchStatus).raw_data as Record<string, unknown>;
          await db.from("plate_events")
            .update({ raw_data: { ...existing, _cooldown_violation: cooldown } })
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

      if (direction === "exit") {
        // --- EXIT ---
        // Use fuzzy match so OCR drift between paired cameras (HD4183 vs
        // VHD4183) doesn't strand the exit event with no session. The
        // defensive direction-flip above also calls findSimilarOpenSession
        // — if THAT returned a session, we're here for a real exit. If it
        // returned nothing, direction was flipped to entry already.
        const openSession = await findSimilarOpenSession(
          db, camera.property_id, normalized, 120, frameUsdot, frameMc, imageHashes.dhash,
        );
        if (!openSession) {
          // Should be unreachable: defensive direction-flip would have
          // caught no-session case above. Belt-and-suspenders log.
          const ev = await db.from("plate_events")
            .insert(baseEventRow(null, "unmatched"))
            .select().single();
          if (ev.error) throw ev.error;
          console.warn(`stray exit (post-flip): no open session for plate=${normalized} property=${camera.property_id}`);
          continue;
        }

        // Parking maneuver buffer: a truck that just entered may back up
        // into a spot, repositioning past the gate cameras within the
        // first few minutes. Without this guard, that re-detection looks
        // like an exit and closes the session — leaving the truck in the
        // lot but invisible to enforcement, and noisy on the partner
        // portal (sessions opening + closing in rapid succession).
        // For the first PARKING_BUFFER_MINUTES after entry, exit reads
        // are recorded but don't close the session.
        const PARKING_BUFFER_MINUTES = 6;
        const sessionAgeMs = openSession.entered_at
          ? now.getTime() - new Date(openSession.entered_at).getTime()
          : 0;
        if (sessionAgeMs < PARKING_BUFFER_MINUTES * 60 * 1000) {
          const ev = await db.from("plate_events")
            .insert(baseEventRow(openSession.id, "unmatched"))
            .select("id").single();
          if (ev.error) throw ev.error;
          eventCount++;
          console.log(`exit suppressed (parking buffer): session=${openSession.id} age=${Math.round(sessionAgeMs/60000)}min plate=${normalized}`);
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

      // Defensive: direction is always 'entry' or 'exit' from the inference
      // above; this branch is unreachable.
      console.warn(`unexpected direction=${direction}; skipping`);
    }

    return json(200, {
      ok: true,
      events: eventCount,
      dedup_suppressed: dedupCount,
      source: extracted.source,
      orientation: camera.orientation, // legacy — kept for log/dashboard parity
      position_order: camera.position_order,
      entry_order: (camera as { entry_order?: number | null }).entry_order ?? null,
      exit_order:  (camera as { exit_order?:  number | null }).exit_order  ?? null,
      gate_id: (camera as { gate_id?: string | null }).gate_id ?? null,
    });
  } catch (err) {
    console.error("camera-snapshot unhandled error:", err instanceof Error ? err.stack ?? err.message : err);
    return json(500, { ok: false, error: "internal_error" });
  }
});

async function callPlateRecognizer(
  imageBytes: Uint8Array,
  cameraId: string,
): Promise<{ ok: true; data: any; source: "sdk" | "cloud" } | { ok: false; status: number; bodyText: string }> {
  // SDK takes priority when configured. The SDK Docker container exposes the
  // SAME /v1/plate-reader/ endpoint as the cloud API, so the request shape
  // is identical — only the host URL and auth differ.
  const usingSdk = !!PR_SDK_URL;
  if (!usingSdk && !PR_TOKEN) return { ok: false, status: 0, bodyText: "PLATE_RECOGNIZER_TOKEN missing (and PR_SDK_URL unset)" };

  const fd = new FormData();
  const imagePart = imageBytes.buffer.slice(
    imageBytes.byteOffset,
    imageBytes.byteOffset + imageBytes.byteLength,
  ) as ArrayBuffer;
  fd.append("upload", new Blob([imagePart], { type: "image/jpeg" }), "snap.jpg");
  fd.append("camera_id", cameraId);

  // Cloud API requires Authorization: Token <api_token>. The self-hosted SDK
  // validates its license on container startup, so per-request auth is
  // unnecessary (and the SDK ignores it if sent).
  const url = usingSdk ? PR_SDK_URL : "https://api.platerecognizer.com/v1/plate-reader/";
  const headers: Record<string, string> = usingSdk ? {} : { Authorization: `Token ${PR_TOKEN}` };

  const res = await fetch(url, { method: "POST", headers, body: fd });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return { ok: false, status: res.status, bodyText };
  }
  const data = await res.json();
  return { ok: true, data, source: usingSdk ? "sdk" : "cloud" };
}

// Call the OpenALPR sidecar (Railway-hosted Python service running OpenALPR
// binary). Returns the best candidate plate that meets the confidence
// threshold, or indicates no usable result. Never throws — any failure
// returns ok: false and the caller falls through to the paid PR API.
async function callOpenAlprSidecar(
  imageBytes: Uint8Array,
  cameraId?: string,
): Promise<{
  ok: boolean;
  bestPlate: string | null;       // gated by OPENALPR_MIN_CONFIDENCE
  bestConfidence: number;
  // ALWAYS-set fields — let the call site decide whether to use a low-conf
  // read for open-session matching even when bestPlate is null because of
  // the threshold gate. Without this the plate string is lost forever and
  // the caller has no way to attempt fuzzy matching against active sessions.
  topReadPlate: string | null;
  topReadConfidence: number;
  rawDetectionCount: number;
  processingMs: number;
  reason?: string;
}> {
  if (!OPENALPR_SIDECAR_URL) {
    return { ok: false, bestPlate: null, bestConfidence: 0, topReadPlate: null, topReadConfidence: 0, rawDetectionCount: 0, processingMs: 0, reason: "sidecar_disabled" };
  }

  // Base64-encode the JPEG bytes for JSON transport.
  const chunkSize = 32 * 1024;
  let binary = "";
  for (let i = 0; i < imageBytes.length; i += chunkSize) {
    binary += String.fromCharCode(...imageBytes.subarray(i, i + chunkSize));
  }
  const b64 = btoa(binary);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENALPR_TIMEOUT_MS);
  try {
    const res = await fetch(`${OPENALPR_SIDECAR_URL}/recognize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_base64: b64,
        auth_token: OPENALPR_SIDECAR_TOKEN || undefined,
        camera_id: cameraId || undefined,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`openalpr-sidecar ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, bestPlate: null, bestConfidence: 0, topReadPlate: null, topReadConfidence: 0, rawDetectionCount: 0, processingMs: 0, reason: `sidecar_http_${res.status}` };
    }
    const body = await res.json();
    const plates: Array<{ plate: string; confidence: number }> = body.plates ?? [];
    const rawDetectionCount = Number(body.raw_detection_count ?? 0);
    if (plates.length === 0) {
      return {
        ok: true,
        bestPlate: null,
        bestConfidence: 0,
        topReadPlate: null,
        topReadConfidence: 0,
        rawDetectionCount,
        processingMs: Number(body.processing_time_ms ?? 0),
        reason: rawDetectionCount === 0 ? "empty_scene" : "no_plate_shaped_text",
      };
    }
    // Pick the highest-confidence candidate meeting the threshold.
    const sorted = plates.slice().sort((a, b) => b.confidence - a.confidence);
    const best = sorted[0];
    if (best.confidence < OPENALPR_MIN_CONFIDENCE) {
      return {
        ok: true,
        bestPlate: null,
        bestConfidence: best.confidence,
        topReadPlate: best.plate,           // ← preserved for open-session matching
        topReadConfidence: best.confidence,
        rawDetectionCount,
        processingMs: Number(body.processing_time_ms ?? 0),
        reason: "below_min_confidence",
      };
    }
    return {
      ok: true,
      bestPlate: best.plate,
      bestConfidence: best.confidence,
      topReadPlate: best.plate,
      topReadConfidence: best.confidence,
      rawDetectionCount,
      processingMs: Number(body.processing_time_ms ?? 0),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`openalpr-sidecar call failed: ${msg}`);
    return { ok: false, bestPlate: null, bestConfidence: 0, topReadPlate: null, topReadConfidence: 0, rawDetectionCount: 0, processingMs: 0, reason: `sidecar_error:${msg.slice(0, 80)}` };
  } finally {
    clearTimeout(timer);
  }
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
  if (!INTERNAL_TOKEN) {
    console.warn("tow-confirm dispatch skipped: INTERNAL_TOKEN not configured");
    return;
  }
  const url = `${SUPABASE_URL}/functions/v1/tow-confirm`;
  const task = fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INTERNAL_TOKEN}`,
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
  now: Date,
): Promise<void> {
  const { data: session, error: sErr } = await db
    .from("plate_sessions")
    .select("state, last_detected_at, normalized_plate, usdot_number, mc_number, entered_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (sErr) { console.warn("inferDirection session fetch failed:", sErr.message); return; }
  if (!session) return;

  // 6-min parking maneuver buffer — applies to BOTH the depth-pair and
  // silence-gap branches below. A truck that just opened a session may
  // back up to position into a spot, retriggering motion at the gate
  // cameras and falsely tripping the depth-pair exit pattern. Skip
  // exit_hinted_at for sessions younger than this floor.
  const PARKING_BUFFER_MS = 6 * 60 * 1000;
  const sessionAgeMs = session.entered_at
    ? now.getTime() - new Date(session.entered_at).getTime()
    : Infinity;
  const insideParkingBuffer = sessionAgeMs < PARKING_BUFFER_MS;

  // ─── Branch 1: cross-camera depth-pair, scoped to a single gate ─────
  // Direction comes from comparing per-direction firing order. If the
  // paired camera fired before this one and its exit_order is lower, the
  // pair is an exit (paired camera fires first on exits, this one second).
  // gate_id scopes the prior-event query.
  const { data: cur } = await db
    .from("alpr_cameras")
    .select("gate_id, entry_order, exit_order")
    .eq("id", currentCameraId)
    .maybeSingle();
  const currentGateId = cur?.gate_id ?? null;
  const currentEntryOrder: number | null = cur?.entry_order ?? null;
  const currentExitOrder:  number | null = cur?.exit_order  ?? null;

  if (currentEntryOrder != null || currentExitOrder != null) {
    const cutoff = new Date(now.getTime() - DIRECTION_WINDOW_SECONDS * 1000).toISOString();
    let priorQ = db
      .from("plate_events")
      .select("camera_id, created_at, alpr_cameras!inner(entry_order, exit_order, gate_id)")
      .eq("property_id", propertyId)
      .neq("camera_id", currentCameraId)
      .gt("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1);
    if (currentGateId) priorQ = priorQ.eq("alpr_cameras.gate_id", currentGateId);
    const { data: prior, error } = await priorQ;
    if (error) console.warn("inferDirection depth-pair query failed:", error.message);
    else {
      const first = (prior ?? [])[0];
      const priorExit  = first?.alpr_cameras?.exit_order;
      if (priorExit != null && currentExitOrder != null && priorExit < currentExitOrder) {
        if (insideParkingBuffer) {
          console.log(`exit hint suppressed (parking buffer) session=${sessionId} age=${Math.round(sessionAgeMs/1000)}s`);
          return;
        }
        const upd = await db.from("plate_sessions")
          .update({ exit_hinted_at: now.toISOString() })
          .eq("id", sessionId);
        if (upd.error) console.warn("exit_hinted_at depth-pair update failed:", upd.error.message);
        else console.log(`exit inferred (depth-pair) for session ${sessionId} on gate ${currentGateId ?? 'any'}: prior_exit_order=${priorExit} cur_exit_order=${currentExitOrder}`);
        return;
      }
    }
  }

  // ─── Branch 2: silence-gap ─────────────────────────────────────────
  // Scope to grace + registered + resident sessions. Expired sessions
  // are closed by closeExpired cron (requires violation resolution).
  //
  // For grace: silence-gap signals the vehicle is leaving via any camera
  // — proof they're not actually parking. Cron's graceExpiry will close
  // the session clean (no violation, no partner email) because
  // exit_hinted_at is set. Critical for multi-tenant properties where
  // Shell/neighbor-business customers share the camered driveway.
  if (session.state !== "grace" && session.state !== "registered" && session.state !== "resident") return;
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

  // Exit signal requires a boundary camera — one whose FOV looks toward
  // the street, not into the lot. These are the cameras that fire FIRST
  // on entries (entry_order=1): their lens is angled toward the street,
  // so they don't see internal lot motion. Interior cameras
  // (entry_order=2) face into the lot and would falsely trigger on
  // transit between fuel pumps and parking.
  if (currentEntryOrder !== 1) {
    console.log(`silence-gap skipped (non-boundary camera) session=${sessionId} entry_order=${currentEntryOrder}`);
    return;
  }

  const idleCutoffMs = now.getTime() - SESSION_IDLE_MINUTES * 60 * 1000;
  if (new Date(session.last_detected_at).getTime() >= idleCutoffMs) return;

  if (insideParkingBuffer) {
    console.log(`silence-gap skipped (parking buffer) session=${sessionId} age=${Math.round(sessionAgeMs/1000)}s`);
    return;
  }

  const upd = await db.from("plate_sessions")
    .update({ exit_hinted_at: now.toISOString() })
    .eq("id", sessionId);
  if (upd.error) console.warn("exit_hinted_at silence-gap update failed:", upd.error.message);
  else {
    const gapSec = Math.round((now.getTime() - new Date(session.last_detected_at).getTime()) / 1000);
    console.log(`exit inferred (silence-gap) for session ${sessionId}: gap=${gapSec}s`);
  }
}

// Forward-pair exit hint: fires from motion-only camera events (no OCR'd
// plate of their own). When this camera fires AND the paired camera at
// the same gate had a recent OCR'd plate read with an open session,
// that's a paired transit that the OCR'd-loop direction inference
// missed (because the OCR fired before the paired motion). Set
// exit_hinted_at so cron closes the session cleanly.
//
// Bounded by the 6-min PARKING_BUFFER to avoid closing a session
// that's still in its entry-pair window. gate_id-scoped. Idempotent.
async function maybePairedMotionExitHint(
  // deno-lint-ignore no-explicit-any
  db: any,
  camera: { id: string; property_id: string; gate_id?: string | null },
  now: Date,
): Promise<void> {
  if (!camera.gate_id) return;

  const cutoff = new Date(now.getTime() - DIRECTION_WINDOW_SECONDS * 1000).toISOString();
  const { data: priorReads, error } = await db
    .from("plate_events")
    .select("session_id, alpr_cameras!inner(gate_id)")
    .eq("property_id", camera.property_id)
    .neq("camera_id", camera.id)
    .eq("alpr_cameras.gate_id", camera.gate_id)
    .neq("plate_text", "")
    .not("session_id", "is", null)
    .gt("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) { console.warn("paired-motion exit hint query failed:", error.message); return; }

  const sessionId = (priorReads ?? [])[0]?.session_id;
  if (!sessionId) return;

  const { data: sess } = await db
    .from("plate_sessions")
    .select("state, entered_at, exit_hinted_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (!sess) return;
  if (!["grace", "registered", "resident"].includes(sess.state)) return;
  if (sess.exit_hinted_at) return;
  if (!sess.entered_at) return;

  const ageMs = now.getTime() - new Date(sess.entered_at).getTime();
  const PARKING_BUFFER_MS = 6 * 60 * 1000;
  if (ageMs < PARKING_BUFFER_MS) return;

  const upd = await db.from("plate_sessions")
    .update({ exit_hinted_at: now.toISOString() })
    .eq("id", sessionId)
    .is("exit_hinted_at", null);
  if (upd.error) console.warn("paired-motion exit hint update failed:", upd.error.message);
  else console.log(`exit inferred (paired-motion) session=${sessionId} gate=${camera.gate_id}`);
}

function isPlausiblePlate(r: PrResult, cameraId: string): boolean {
  const normalized = normalizePlate(r.plate ?? "");

  // ─── Layer 2: plate SHAPE ──────────────────────────────────────────
  // Length 5-8 covers all US plate formats. Always applied — even
  // overridden cameras must pass shape gates (a 3-char "AB7" is junk
  // regardless of how confident PR is).
  if (normalized.length < PR_MIN_PLATE_LEN || normalized.length > 8) return false;
  if (!/[A-Z]/.test(normalized) || !/\d/.test(normalized)) return false;

  // ─── Per-camera override fast path ─────────────────────────────────
  // Cameras in PR_MIN_SCORE_OVERRIDES have a single floor and bypass
  // the length-scaled ladder + vehicle gate below. Used for far-mounted
  // gate cams where small plates produce low PR + low vehicle scores.
  const override = PR_MIN_SCORE_OVERRIDES[cameraId];
  if (typeof override === "number") {
    return r.score >= override;
  }

  // ─── Layer 1: VEHICLE must have been detected ──────────────────────
  // EXCEPTION: when PR is confident in the plate text (>= 0.80), we
  // trust PR's plate signal and bypass the vehicle gate. Covers night-IR
  // shots where the truck body is dark but the plate is sharp.
  const vehicleScore = typeof r.vehicle?.score === "number" ? r.vehicle.score : 0;
  if (r.score < 0.80 && vehicleScore < REQUIRE_VEHICLE_SCORE) return false;

  // ─── Layer 3: CONFIDENCE scales with length ────────────────────────
  const minConf = normalized.length === 5 ? 0.95
                : normalized.length === 6 ? 0.85
                : 0.80;
  if (r.score < Math.max(minConf, PR_MIN_SCORE)) return false;

  return true;
}
