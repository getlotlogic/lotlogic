import { normalizePlate } from "./normalize.ts";
import { matchPlate } from "./match.ts";
import type { Deps, PrWebhookPayload } from "./types.ts";

export type PipelineResult = {
  status: number;
  body: Record<string, unknown>;
};

export async function runPipeline(req: Request, deps: Deps): Promise<PipelineResult> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return { status: 200, body: { ok: false, reason: "multipart_parse_failed", detail: String(err) } };
  }

  const jsonField = form.get("json");
  const upload = form.get("upload");
  if (typeof jsonField !== "string") {
    return { status: 200, body: { ok: false, reason: "missing_json_field" } };
  }

  let payload: PrWebhookPayload;
  try {
    payload = JSON.parse(jsonField);
  } catch (err) {
    return { status: 200, body: { ok: false, reason: "json_parse_failed", detail: String(err) } };
  }

  const cameraId = payload.data.camera_id;
  if (!cameraId) {
    return { status: 200, body: { ok: false, reason: "missing_camera_id" } };
  }

  const cameraQ = await deps.db
    .from("alpr_cameras")
    .select("id,property_id,api_key,active")
    .eq("api_key", cameraId)
    .eq("active", true)
    .limit(1);
  if (cameraQ.error) throw cameraQ.error;
  const camera = (cameraQ.data ?? [])[0];
  if (!camera) {
    return { status: 200, body: { ok: false, reason: "unknown_camera_id", camera_id: cameraId } };
  }

  const surviving = (payload.data.results ?? []).filter((r) => r.score >= deps.env.PR_MIN_SCORE);
  if (surviving.length === 0) {
    return { status: 200, body: { ok: true, events: 0, reason: "all_below_threshold" } };
  }

  const uploadBytes = upload instanceof Blob ? new Uint8Array(await upload.arrayBuffer()) : null;

  let eventCount = 0;
  let violationCount = 0;

  for (const result of surviving) {
    const t = deps.now();
    const plateUpper = result.plate.toUpperCase();
    const normalized = normalizePlate(result.plate);
    const epochMs = t.getTime();
    const dateStr = t.toISOString().slice(0, 10);
    const key = `${camera.property_id}/${dateStr}/${camera.api_key}-${epochMs}-${plateUpper}.jpg`;

    let imageUrl: string | null = null;
    let imageError: string | null = null;
    if (uploadBytes) {
      const upRes = await deps.r2(key, uploadBytes);
      if (upRes.ok) imageUrl = upRes.url;
      else imageError = upRes.error;
    }

    // Dedup check
    let dedupSuppressed = false;
    if (deps.env.PR_DEDUP_WINDOW_SECONDS > 0) {
      const since = new Date(t.getTime() - deps.env.PR_DEDUP_WINDOW_SECONDS * 1000).toISOString();
      const recent = await deps.db
        .from("plate_events")
        .select("id,property_id,normalized_plate,created_at")
        .eq("property_id", camera.property_id)
        .eq("normalized_plate", normalized)
        .gte("created_at", since)
        .limit(1);
      if (recent.error) throw recent.error;
      if ((recent.data ?? []).length > 0) dedupSuppressed = true;
    }

    let outcome = dedupSuppressed
      ? { kind: "dedup_suppressed" as const }
      : await matchPlate(deps.db, camera.property_id, normalized, t);

    const matchStatus = outcome.kind;
    const matchReason = outcome.kind === "dedup_suppressed" ? "within window" : null;

    const eventRow: Record<string, unknown> = {
      camera_id: camera.id,
      property_id: camera.property_id,
      plate_text: plateUpper,
      normalized_plate: normalized,
      confidence: result.score,
      image_url: imageUrl,
      event_type: "entry",
      raw_data: { ...result, _pr_payload: payload.data, ...(imageError ? { image_upload_error: imageError } : {}) },
      match_status: matchStatus,
      match_reason: matchReason,
      matched_at: outcome.kind !== "unmatched" && outcome.kind !== "dedup_suppressed" ? t.toISOString() : null,
      ...(outcome.kind === "resident" ? { resident_plate_id: outcome.resident_plate_id } : {}),
      ...(outcome.kind === "visitor_pass" ? { visitor_pass_id: outcome.visitor_pass_id } : {}),
    };

    const evIns = await deps.db.from("plate_events").insert(eventRow).select().single();
    if (evIns.error) throw evIns.error;
    eventCount++;

    if (outcome.kind === "unmatched") {
      const vIns = await deps.db.from("alpr_violations").insert({
        property_id: camera.property_id,
        plate_event_id: evIns.data.id,
        plate_text: plateUpper,
        status: "pending",
        violation_type: "alpr_unmatched",
      }).select().single();
      if (vIns.error) throw vIns.error;
      violationCount++;
    }
  }

  return { status: 200, body: { ok: true, events: eventCount, violations: violationCount } };
}
