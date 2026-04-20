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
  source: "milesight_json" | "multipart" | "raw";
  rawMeta: Record<string, unknown> | null; // included in plate_events.raw_data
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
    const extracted = extractMilesightPayload(obj);
    if (extracted) return extracted;
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

  const devMac = typeof values.devMac === "string" ? (values.devMac as string) : null;

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

  return {
    bytes,
    cameraHint: devMac,
    source: "milesight_json",
    rawMeta,
  };
}
