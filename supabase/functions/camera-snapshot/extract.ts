// Image extraction from whatever a camera posted. Returns the JPEG + a
// camera hint + source + any rawMeta we want to preserve. Note: per-detection
// fields like `vehicle.type` come back from Plate Recognizer, NOT from the
// camera, so they're extracted later in index.ts from the PR response per
// result.
//
// Accept anything a dumb ANPR-less camera might POST:
//
//  * Milesight 4G Traffic Sensing Camera — JSON body with the JPEG embedded as
//    `values.image` as a `data:image/jpeg;base64,...` data URI, and the camera
//    identity carried in `values.devMac`.
//  * Generic multipart/form-data with a file field called upload|image|file|...
//  * Raw image/jpeg or application/octet-stream with JPEG bytes in the body.
//
// Returns the decoded JPEG bytes plus any auxiliary identity/metadata the
// camera volunteered (used to look up alpr_cameras when the URL path
// doesn't include an api_key).

export type Extracted = {
  bytes: Uint8Array;
  cameraHint: string | null;  // devMac, device id, or null
  source: "milesight_json" | "milesight_lpr" | "multipart" | "raw";
  rawMeta: Record<string, unknown> | null; // included in plate_events.raw_data
  // Onboard-LPR cameras (TS4467 etc.) deliver the OCR result with the snapshot.
  // When present, index.ts skips the Plate Recognizer round-trip.
  onboardLpr?: {
    plate: string;
    plateConfidence: number | null;  // 0..1
    direction: "Approach" | "Leave" | null;  // from camera direction or trigger-line
    plateColor: string | null;
    vehicleType: string | null;
    vehicleColor: string | null;
    vehicleBrand: string | null;
    detectionRegion: string | null;  // ROI name from camera
    eventType: string | null;  // 'Plate Event' | 'Visitor Event' | 'White List Event' | 'Black List Event' | etc.
  };
};

const COMMON_IMAGE_FIELDS = ["upload", "image", "file", "snapshot", "picture", "photo"];

export async function extractFromRequest(req: Request): Promise<Extracted | null> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();

  if (ct.includes("application/json")) {
    const text = await req.text();
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(text);
    } catch {
      return null;
    }
    // TS4467 (onboard-LPR) shape is recognized first because both shapes are
    // JSON; the LPR shape has root-level `mac_address` + `full_snapshot` while
    // the 4G Traffic Sensing shape has nested `values.devMac` + `values.image`.
    const lpr = extractMilesightLprPayload(obj);
    if (lpr) return lpr;
    const legacy = extractMilesightPayload(obj);
    if (legacy) return legacy;
    return null;
  }

  if (ct.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return null;
    }
    for (const name of COMMON_IMAGE_FIELDS) {
      const v = form.get(name);
      if (v instanceof Blob && v.size > 0) {
        const bytes = new Uint8Array(await v.arrayBuffer());
        return { bytes, cameraHint: null, source: "multipart", rawMeta: null };
      }
    }
    // fallback: first blob
    for (const [, v] of form.entries()) {
      if (v instanceof Blob && v.size > 0) {
        const bytes = new Uint8Array(await v.arrayBuffer());
        return { bytes, cameraHint: null, source: "multipart", rawMeta: null };
      }
    }
    return null;
  }

  // Raw bytes.
  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return null;
  return {
    bytes: new Uint8Array(buf),
    cameraHint: null,
    source: "raw",
    rawMeta: null,
  };
}

/**
 * Milesight webhook shape (4G Traffic Sensing Camera):
 * {
 *   "ts": 1776620819627,
 *   "topic": "4GSolarCam/Snapshot",
 *   "gps": { ... },
 *   "values": {
 *     "devName": "4G Traffic Sensing Camera",
 *     "devMac": "1CC31660025E",
 *     "file": "202604191046584644C.jpg",
 *     "time": 1776620818,
 *     "dayNight": "day",
 *     "imageSize": 35596,
 *     "image": "data:image/jpeg;base64,/9j/4AAQ..."
 *   }
 * }
 */
export function extractMilesightPayload(obj: Record<string, unknown>): Extracted | null {
  const values = obj.values as Record<string, unknown> | undefined;
  if (!values || typeof values !== "object") return null;
  const imageField = values.image;
  if (typeof imageField !== "string") return null;

  const m = imageField.match(/^data:image\/\w+;base64,(.+)$/);
  const b64 = m ? m[1] : imageField;
  let bytes: Uint8Array;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return null;
  }
  if (bytes.byteLength === 0) return null;
  // Reject obviously-truncated payloads (4G modem stalls produce
  // a JFIF header + EOI marker totaling ~22 bytes — see the 290-row
  // 2026-04-19 incident). 1KB floor catches them. Real Milesight
  // captures are typically 30-200KB.
  if (bytes.byteLength < 1024) return null;

  // Normalize the devMac to lowercase + alphanumeric-only so it matches
  // the convention used by alpr_cameras.api_key. Without this, an SC211
  // sending "1CC31660025E" wouldn't match a DB row stored as
  // "1cc31660025e" — every read would silently 200 with unknown_camera.
  const devMac = typeof values.devMac === "string"
    ? (values.devMac as string).toLowerCase().replace(/[^a-z0-9]/g, "")
    : null;

  // rawMeta is what we preserve in plate_events.raw_data — drop the (huge)
  // base64 blob but keep everything else useful for forensics.
  const valuesWithoutImage: Record<string, unknown> = { ...values };
  delete valuesWithoutImage.image;
  const rawMeta: Record<string, unknown> = {
    milesight: {
      ts: obj.ts ?? null,
      topic: obj.topic ?? null,
      gps: obj.gps ?? null,
      values: valuesWithoutImage,
    },
  };

  // ANPR variants of the 4G Solar Cam family include the onboard-detected
  // plate text alongside the image. The traffic-sensing variant does not.
  // Try every place a plate string is known to appear; first hit wins.
  const candidatePlate =
    (typeof values.plate === "string" && values.plate) ||
    (typeof values.licensePlate === "string" && values.licensePlate) ||
    (typeof values.license_plate === "string" && values.license_plate) ||
    (typeof values.lpr === "string" && values.lpr) ||
    (typeof values.anpr === "string" && values.anpr) ||
    (typeof obj.plate === "string" && obj.plate) ||
    (typeof obj.licensePlate === "string" && obj.licensePlate) ||
    "";

  const onboardLpr = candidatePlate ? {
    plate: String(candidatePlate),
    plateConfidence: null,
    direction: null,
    plateColor: null,
    vehicleType: null,
    vehicleColor: null,
    vehicleBrand: null,
    detectionRegion: null,
    eventType: (typeof obj.topic === "string" ? obj.topic : null),
  } : undefined;

  // Surface the raw key list so we can see what an ANPR variant actually
  // ships. Stored in rawMeta so the diag insert can pluck it.
  (rawMeta as Record<string, unknown>).milesight_keys = {
    root: Object.keys(obj),
    values: Object.keys(values),
  };

  return {
    bytes,
    cameraHint: devMac,
    source: "milesight_json",
    rawMeta,
    ...(onboardLpr ? { onboardLpr } : {}),
  };
}

/**
 * Milesight TS4467 (onboard-LPR) Data Transmission Post shape:
 * {
 *   "event_type": "Plate Event" | "Visitor Event" | "White List Event" | "Black List Event" | ...,
 *   "device_name": "...",
 *   "mac_address": "1cc31653ac72",
 *   "sn": "...",
 *   "time": "2026-05-12 10:30:00",
 *   "detection_region": "1",
 *   "detection_region_name": "ROI_1",
 *   "trigger_line_state": "in" | "out" | ...,
 *   "license_plate": "ABC123",
 *   "plate_confidence": "0.95",
 *   "country_region": "US",
 *   "plate_type": "...",
 *   "plate_color": "white",
 *   "vehicle_type": "Car",
 *   "vehicle_color": "white",
 *   "vehicle_brand": "Toyota",
 *   "direction": "Approach" | "Leave",
 *   "full_snapshot": "<base64-JPEG, no data: prefix>",
 *   "license_plate_snapshot": "<base64>",
 *   "vehicle_snapshot": "<base64>",
 *   ...
 * }
 *
 * The camera already OCR'd the plate — index.ts skips the Plate Recognizer
 * call when `onboardLpr` is present.
 */
export function extractMilesightLprPayload(obj: Record<string, unknown>): Extracted | null {
  // Distinguishing signal: TS4467 shape has root-level mac_address + full_snapshot
  // (no nested values). 4G Traffic Sensing has nested values.devMac + values.image.
  const mac = obj.mac_address;
  const fullSnapshot = obj.full_snapshot;
  if (typeof mac !== "string" || typeof fullSnapshot !== "string") return null;
  if (fullSnapshot.length < 64) return null;

  // Image: TS4467 sends raw base64 with no `data:image/jpeg;base64,` prefix,
  // but accept both forms defensively.
  const dataUriMatch = fullSnapshot.match(/^data:image\/\w+;base64,(.+)$/);
  const b64 = dataUriMatch ? dataUriMatch[1] : fullSnapshot;
  let bytes: Uint8Array;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return null;
  }
  if (bytes.byteLength < 1024) return null;

  // Normalize MAC: lowercase, strip separators. alpr_cameras.api_key is the
  // bare hex (e.g. '1cc31653ac72'), matching the Milesight TS4467 convention.
  const cameraHint = mac.toLowerCase().replace(/[^a-f0-9]/g, "");

  // Parse plate confidence — TS4467 sends as string, sometimes percent, sometimes 0..1.
  const rawConf = obj.plate_confidence;
  let plateConfidence: number | null = null;
  if (typeof rawConf === "string" || typeof rawConf === "number") {
    const n = Number(rawConf);
    if (!Number.isNaN(n)) plateConfidence = n > 1 ? n / 100 : n;
  }

  const directionRaw = typeof obj.direction === "string" ? obj.direction : null;
  const direction =
    directionRaw === "Approach" || directionRaw === "Leave" ? directionRaw : null;

  const strOrNull = (k: string): string | null => {
    const v = obj[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };

  // rawMeta: keep everything except the huge base64 blobs so forensics can
  // still recover coords, confidence, attributes, trigger_line_state, etc.
  const rawMetaSrc: Record<string, unknown> = { ...obj };
  delete rawMetaSrc.full_snapshot;
  delete rawMetaSrc.license_plate_snapshot;
  delete rawMetaSrc.vehicle_snapshot;
  delete rawMetaSrc.violation_snapshot;
  delete rawMetaSrc.evidence_snapshot0;
  delete rawMetaSrc.evidence_snapshot1;

  return {
    bytes,
    cameraHint,
    source: "milesight_lpr",
    rawMeta: { milesight_lpr: rawMetaSrc },
    onboardLpr: {
      plate: typeof obj.license_plate === "string" ? obj.license_plate : "",
      plateConfidence,
      direction,
      plateColor: strOrNull("plate_color"),
      vehicleType: strOrNull("vehicle_type"),
      vehicleColor: strOrNull("vehicle_color"),
      vehicleBrand: strOrNull("vehicle_brand"),
      detectionRegion: strOrNull("detection_region_name") || strOrNull("detection_region"),
      eventType: strOrNull("event_type"),
    },
  };
}
