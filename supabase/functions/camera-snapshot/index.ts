import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { makeR2Uploader } from "../pr-ingest/r2.ts";
import { normalizePlate } from "../pr-ingest/normalize.ts";
import { extractFromRequest } from "./extract.ts";
import { parsePath } from "./path.ts";
import { findOpenSession, findSimilarOpenSession, findActiveResident, findActiveVisitorPass, insertSession, decideExitOutcome, applyExitOutcome } from "./sessions.ts";
import { isPlateHeld } from "./holds.ts";
import { extractUsdot } from "./usdot-ocr.ts";
import { computeImageHashes, hammingDistance } from "./image-hash.ts";

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
const INHERIT_WINDOW_SECONDS = Number(Deno.env.get("INHERIT_WINDOW_SECONDS") ?? "30");
// Image-similarity dedup window. Stationary vehicles (parked in FoV) can
// trigger motion events for minutes or hours — wind, shadow, trailer sway,
// engine idle vibration. This window governs how far back we look for a
// matching image hash. Larger = more PR savings but more risk of stale
// inherit when a new vehicle arrives at the same spot.
const IMAGE_HASH_WINDOW_SECONDS = Number(Deno.env.get("IMAGE_HASH_WINDOW_SECONDS") ?? "300");
// Hamming-distance threshold for dHash similarity. 0 = byte-identical,
// 1-5 = visually same scene with noise/compression variance, 6-12 =
// similar scene with minor lighting/motion shift, 15+ = different scene.
// Moving vehicles on consecutive frames produce dHash drift in the 6-12
// range (plate bytes shift position even when the scene is "the same
// truck"). 12 is tight enough to reject totally different scenes but
// loose enough to match same-truck-moving frames. Guard-railed by a
// tight time gate (DHASH_TIME_WINDOW_SECONDS) so visually-similar but
// temporally-distant scenes don't falsely inherit.
const DHASH_SIMILARITY_THRESHOLD = Number(Deno.env.get("DHASH_SIMILARITY_THRESHOLD") ?? "12");
// Time gate for dHash matches. A similar-looking frame more than this
// many seconds away is almost certainly a DIFFERENT vehicle happening
// to sit in the same spot. 20s covers "same truck still in FOV".
const DHASH_TIME_WINDOW_SECONDS = Number(Deno.env.get("DHASH_TIME_WINDOW_SECONDS") ?? "20");
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
// Direction inference: if a plate is detected on camera B within this
// window after being detected on camera A (different position_order), we
// infer direction of travel. Entries → no action. Exits → set session's
// exit_hinted_at so cron closes it on a short buffer instead of the
// default 2h buffer.
const DIRECTION_WINDOW_SECONDS = Number(Deno.env.get("DIRECTION_WINDOW_SECONDS") ?? "30");
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

    // ── Tier 0: in-flight race guard ──────────────────────────────────
    // If ANY recent event exists on this PROPERTY — even one whose session
    // hasn't been backfilled yet — another frame is mid-processing. The
    // previous code required session_id IS NOT NULL, which meant rapid
    // bursts of a new plate all hit PR before the first frame finished
    // creating its session (observed in prod 2026-04-24: 11 events on
    // plate 210CYL within 50s, all full-PR, all on the same session once
    // backfills resolved). Scope is property-wide (not camera-wide) because
    // the same truck can arrive at gate A and trigger gate B within the
    // inherit window — both frames race to create the session. Skip PR
    // without writing a row — the in-flight frame will create the
    // canonical event.
    const inheritCutoff = new Date(Date.now() - INHERIT_WINDOW_SECONDS * 1000).toISOString();
    const inflightProbe = await db
      .from("plate_events")
      .select("id, session_id, created_at")
      .eq("property_id", camera.property_id)
      .gt("created_at", inheritCutoff)
      .is("session_id", null)
      .order("created_at", { ascending: false })
      .limit(1);
    if (inflightProbe.data && inflightProbe.data.length > 0) {
      console.log(`inflight-dedup skip: camera=${camera.api_key} prior_event=${inflightProbe.data[0].id}`);
      return json(200, {
        ok: true,
        events: 0,
        source: extracted.source,
        deduped: true,
        inherit_tier: "inflight",
      });
    }

    // Compute image hashes for dedup AFTER the Tier 0 check.
    // SHA-256 is cheap (~2ms); dHash requires JPEG decode (~100ms). Computing
    // before Tier 0 wastes ~100ms on every frame that would have deduped
    // upstream anyway. Both get stored on plate_events so future frames
    // can match against them.
    const imageHashes = await computeImageHashes(extracted.bytes);

    // ── Tier 1: inherit from recent event on this camera ──────────────
    // Two-query approach — the !inner JOIN syntax in PostgREST was
    // silently returning empty in some cases, causing Tier 1 to miss
    // legitimate dedup opportunities. Splitting into plate_events query
    // + plate_sessions query is more reliable.
    const recentQuery = await db
      .from("plate_events")
      .select("session_id, plate_text, normalized_plate, usdot_number, mc_number, confidence")
      .eq("camera_id", camera.id)
      .gt("created_at", inheritCutoff)
      .not("session_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);

    let recent: { session_id: string; plate_text: string; normalized_plate: string; usdot_number: string | null; mc_number: string | null; confidence: number } | undefined;
    const recentRaw = (recentQuery.data ?? [])[0] as typeof recent;
    if (recentRaw?.session_id) {
      // Validate the session is still open
      const sessCheck = await db
        .from("plate_sessions")
        .select("exited_at")
        .eq("id", recentRaw.session_id)
        .maybeSingle();
      if (sessCheck.data && !sessCheck.data.exited_at) {
        recent = recentRaw;
      }
    }

    if (recent && recent.session_id) {
      // We've already confirmed this plate on a recent frame in this session.
      // Skip the R2 upload — operators have the canonical image from the entry
      // event; subsequent inherited frames are timeline noise visually. Keep
      // the plate_events row though: silence-gap exit detection, dwell-time
      // calculation, and direction inference all key off `created_at` of the
      // row, not the image. Killing the row breaks the state machine.
      // Net cost: 200-byte DB row vs. 60-100KB R2 upload. ~99% R2 savings.
      const nowDate = new Date();
      const imageUrl: string | null = null;
      // Clamp inherited confidence. Reusing the prior event's score as-is
      // lets a single hi-confidence read propagate forever — every subsequent
      // inherited frame gets that same 0.9+ value, which inflates the
      // "anchored" fuzzy-match tolerance in findSimilarOpenSession (≥3
      // hi-conf events → maxEdits=2). Cap inherited confidence at 0.70 so
      // these events never count toward the anchor threshold. The real
      // plate confidence lives on the original burst events.
      const inheritedConfidence = Math.min(recent.confidence ?? 0.70, 0.70);
      const ev = await db.from("plate_events").insert({
        camera_id: camera.id,
        property_id: camera.property_id,
        plate_text: recent.plate_text,
        normalized_plate: recent.normalized_plate,
        confidence: inheritedConfidence,
        image_url: imageUrl,
        image_sha256: imageHashes.sha256,
        image_dhash: imageHashes.dhash,
        event_type: "entry",
        usdot_number: recent.usdot_number,
        mc_number: recent.mc_number,
        raw_data: {
          _source: `camera-snapshot:${extracted.source}:inherited`,
          _inherited_from_session: recent.session_id,
          _original_confidence: recent.confidence,
          _image_suppressed: "session_already_confirmed",
          ...(extracted.rawMeta ?? {}),
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
        inherit_tier: "recent",
        session_id: recent.session_id,
        plate_text: recent.plate_text,
      });
    }

    // ── Tier 4 image-similarity dedup (PR cost killer) ─────────────────
    // Longer window than Tier 3: up to IMAGE_HASH_WINDOW_SECONDS ago. Catches
    // stationary vehicles that trigger motion sporadically (wind/shadow/sway)
    // for minutes at a time. Two-layer match:
    //   (a) SHA-256 equality — truly byte-identical JPEG (fast DB lookup)
    //   (b) dHash Hamming ≤ threshold AND within DHASH_TIME_WINDOW_SECONDS —
    //       visually same scene, temporally close (same truck still there).
    // Two-query approach — same !inner PostgREST silent-empty bug that bit
    // Tier 1 also applies here; explicit session lookup is reliable.
    const hashCutoff = new Date(Date.now() - IMAGE_HASH_WINDOW_SECONDS * 1000).toISOString();
    const dhashCutoffMs = Date.now() - DHASH_TIME_WINDOW_SECONDS * 1000;
    const candidatesQuery = await db
      .from("plate_events")
      .select("session_id, plate_text, normalized_plate, usdot_number, mc_number, confidence, image_sha256, image_dhash, created_at")
      .eq("camera_id", camera.id)
      .gt("created_at", hashCutoff)
      .not("session_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(20);

    let hashMatch: { session_id: string; plate_text: string; normalized_plate: string; usdot_number: string | null; mc_number: string | null; confidence: number; tier: "sha256" | "dhash"; distance?: number } | null = null;
    const candidates = (candidatesQuery.data ?? []) as Array<{ session_id: string; plate_text: string; normalized_plate: string; usdot_number: string | null; mc_number: string | null; confidence: number; image_sha256: string | null; image_dhash: string | null; created_at: string }>;
    for (const c of candidates) {
      const ageMs = Date.now() - new Date(c.created_at).getTime();
      if (c.image_sha256 && c.image_sha256 === imageHashes.sha256) {
        // SHA-256 exact match — any age within IMAGE_HASH_WINDOW_SECONDS.
        hashMatch = { ...c, tier: "sha256" };
        break;
      }
      if (imageHashes.dhash && c.image_dhash && new Date(c.created_at).getTime() >= dhashCutoffMs) {
        // dHash near-match — only if candidate is within the tight time
        // window. Prevents stale "same parking spot, different truck"
        // false inherits after the original truck left.
        const d = hammingDistance(imageHashes.dhash, c.image_dhash);
        if (d <= DHASH_SIMILARITY_THRESHOLD) {
          hashMatch = { ...c, tier: "dhash", distance: d };
          break;
        }
      }
      // Suppress ageMs lint — reserved for future age-weighted scoring.
      void ageMs;
    }

    // Verify the candidate's session is still open (replaces the !inner
    // JOIN that was silently returning empty in some cases).
    if (hashMatch) {
      const sessCheck = await db
        .from("plate_sessions")
        .select("exited_at")
        .eq("id", hashMatch.session_id)
        .maybeSingle();
      if (!sessCheck.data || sessCheck.data.exited_at) {
        hashMatch = null;
      }
    }

    // ── Tier 5: OpenALPR sidecar pre-filter (cost killer) ─────────────
    // Before paying for a Plate Recognizer call, ask our free OpenALPR
    // sidecar what plate it sees. If the sidecar returns a plate that
    // matches an existing open session on this property (exact or fuzzy),
    // inherit that session — PR never gets called.
    // Only runs when the sidecar URL is configured. Empty or low-conf
    // sidecar reads fall through to PR for the "pro" read.
    if (!hashMatch && OPENALPR_SIDECAR_URL) {
      const sidecar = await callOpenAlprSidecar(extracted.bytes);
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
        const sidecarSession = await findSimilarOpenSession(db, camera.property_id, sidecarNormalized, 600);
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

          await inferDirection(db, sidecarSession.id, camera.property_id, sidecarSession.normalized_plate, camera.id, camera.position_order ?? null, nowDate);
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
        // No matching session. If sidecar's read was BELOW the confidence
        // gate, treat as no plate (fall to the next branch, may skip PR).
        // If above gate, fall through to PR — could be a new vehicle.
        if (sidecar.bestPlate) {
          console.log(`openalpr-sidecar read "${sidecar.bestPlate}" conf=${sidecar.bestConfidence} but no matching session; falling through to PR`);
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
        //   • no_plate_shaped_text → fall through to PR. Trust PR's better
        //     OCR over easyocr's heuristic. Cost goes up but recall is the
        //     priority — missing real plates means missing violations.
        //   • below_min_confidence → fall through to PR (unchanged).
        //
        // Diagnostic rows still written for both empty_scene and
        // no_plate_shaped_text so the labeling UI can show them. This
        // means LOG_REJECTED rows happen even when we DO call PR — the
        // diagnostic captures sidecar's verdict regardless of downstream.
        const isHardSkip = sidecar.reason === "empty_scene";
        const fallThroughReason = sidecar.reason === "below_min_confidence"
          ? `below_min_confidence (${sidecar.bestConfidence.toFixed(2)})`
          : sidecar.reason ?? "no_plate";
        if (!isHardSkip) {
          console.log(`openalpr-sidecar ${fallThroughReason}, falling through to PR (loose gate)`);
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
            const key = `diagnostic/${dateStr}/${camera.api_key}-${epochMs}-rejected-${reason}.jpg`;
            let imageUrl: string | null = null;
            const upRes = await r2(key, extracted.bytes);
            if (upRes.ok) imageUrl = upRes.url;
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

    if (hashMatch && hashMatch.session_id) {
      // Hash-dedup match — same image bytes (or near-identical dHash) as a
      // recent frame on this camera. Skip the R2 upload; we already have
      // the canonical image from the prior frame.
      const nowDate = new Date();
      const inheritedConfidence = Math.min(hashMatch.confidence ?? 0.70, 0.70);
      const ev = await db.from("plate_events").insert({
        camera_id: camera.id,
        property_id: camera.property_id,
        plate_text: hashMatch.plate_text,
        normalized_plate: hashMatch.normalized_plate,
        confidence: inheritedConfidence,
        image_url: null,
        image_sha256: imageHashes.sha256,
        image_dhash: imageHashes.dhash,
        event_type: "entry",
        usdot_number: hashMatch.usdot_number,
        mc_number: hashMatch.mc_number,
        raw_data: {
          _source: `camera-snapshot:${extracted.source}:hash-${hashMatch.tier}`,
          _inherited_from_session: hashMatch.session_id,
          _hash_tier: hashMatch.tier,
          _hash_distance: hashMatch.distance ?? 0,
          _original_confidence: hashMatch.confidence,
          _image_suppressed: "session_already_confirmed",
          ...(extracted.rawMeta ?? {}),
        },
        match_status: "dedup_suppressed",
        match_reason: `image similarity (${hashMatch.tier}) within ${IMAGE_HASH_WINDOW_SECONDS}s`,
        matched_at: nowDate.toISOString(),
        session_id: hashMatch.session_id,
      });
      if (ev.error) throw ev.error;

      // Run direction inference + last_detected_at bump, same as Tier 3.
      await inferDirection(db, hashMatch.session_id, camera.property_id, hashMatch.normalized_plate, camera.id, camera.position_order ?? null, nowDate);
      await db.from("plate_sessions")
        .update({ last_detected_at: nowDate.toISOString() })
        .eq("id", hashMatch.session_id);

      console.log(`hash-dedup match session=${hashMatch.session_id} tier=${hashMatch.tier} dist=${hashMatch.distance ?? 0}`);
      return json(200, {
        ok: true,
        events: 1,
        source: extracted.source,
        inherited: true,
        inherit_tier: hashMatch.tier,
        session_id: hashMatch.session_id,
        plate_text: hashMatch.plate_text,
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
      ? await extractUsdot(extracted.bytes, { token: USDOT_TOKEN, minScore: USDOT_MIN_SCORE, cameraId: cameraApiKey })
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
        const key = `diagnostic/${dateStr}/${camera.api_key}-${epochMs}-rejected-pr_no_plate.jpg`;
        let imageUrl: string | null = null;
        const upRes = await r2(key, extracted.bytes);
        if (upRes.ok) imageUrl = upRes.url;
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
            _usdot_called: USDOT_ENABLED && !!USDOT_TOKEN,
            _usdot_found: usdotResult.kind !== "none",
            ...(extracted.rawMeta ?? {}),
          },
          match_status: "sidecar_rejected",
          match_reason: `PR called but no usable plate (results=${results.length})`,
          session_id: null,
        });
        if (diag.error) console.error(`pr-no-plate diagnostic insert failed: ${diag.error.message}`);
      }
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
        image_sha256: imageHashes.sha256,
        image_dhash: imageHashes.dhash,
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

// Call the OpenALPR sidecar (Railway-hosted Python service running OpenALPR
// binary). Returns the best candidate plate that meets the confidence
// threshold, or indicates no usable result. Never throws — any failure
// returns ok: false and the caller falls through to the paid PR API.
async function callOpenAlprSidecar(
  imageBytes: Uint8Array,
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

  // Exit signal requires a STREET-FACING (position_order=1) camera.
  // Interior cameras (position_order=2) see transit movement — a vehicle
  // that entered south, fueled at Shell, and is now crossing the interior
  // on its way to truck parking should NOT be treated as exiting. Only
  // detections at the property boundary cameras count as exit signals.
  //
  // Real-world flow this guards against:
  //   t=0   Camera 6 entry (session opens)
  //   t=20  truck at Shell fuel pumps (invisible)
  //   t=20  Camera 5 fires (truck heading east into parking)
  //     → WITHOUT this guard: silence-gap sees 20-min gap, closes
  //       session clean, truck then parks illegally with no session.
  //     → WITH this guard: Camera 5 is order=2, silence-gap skipped,
  //       session remains open through grace → violation fires at 30m.
  if (currentPositionOrder !== 1) {
    console.log(`silence-gap skipped (non-exit camera) session=${sessionId} current_order=${currentPositionOrder}`);
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
