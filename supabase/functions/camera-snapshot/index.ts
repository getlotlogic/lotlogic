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
const PR_MIN_PLATE_LEN = Number(Deno.env.get("PR_MIN_PLATE_LEN") ?? "4");
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
      .select("id,property_id,api_key,active,orientation,usdot_active_until")
      .eq("api_key", cameraApiKey)
      .eq("active", true)
      .limit(1);
    if (cameraQ.error) throw cameraQ.error;
    const camera = (cameraQ.data ?? [])[0];
    if (!camera) return json(200, { ok: false, reason: "unknown_camera", api_key: cameraApiKey });

    // Call PR first. Only call USDOT when PR returned NO plate — i.e. the
    // camera angle didn't catch the plate. When PR sees a plate at all (even
    // at lowish confidence), we trust that read and skip the ParkPow call.
    const prResp = await callPlateRecognizer(extracted.bytes, cameraApiKey);
    if (!prResp.ok) {
      console.warn("camera-snapshot PR call failed:", prResp.status, prResp.bodyText.slice(0, 200));
      return json(200, { ok: false, reason: "pr_call_failed", status: prResp.status });
    }

    const results = Array.isArray(prResp.data?.results) ? prResp.data.results : [];
    // Drop low-score AND short-plate reads. "HH" at 0.82 passes the score
    // gate but isn't a plate — it's a partial OCR crop. Treat it as no-plate
    // so USDOT fallback can try to read the DOT off the side panel.
    let surviving = results.filter((r: { score: number; plate: string }) =>
      r.score >= PR_MIN_SCORE &&
      normalizePlate(r.plate).length >= PR_MIN_PLATE_LEN
    );

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
