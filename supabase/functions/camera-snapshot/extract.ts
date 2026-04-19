// Milesight's "HTTP POST" feature sends the image body with minimal
// configurability — it can be `multipart/form-data` with a named file field,
// `image/jpeg` with raw bytes, or `application/octet-stream`. We accept all
// three so the camera can be dropped in without caring about the shape.

const COMMON_IMAGE_FIELDS = ["upload", "image", "file", "snapshot", "picture", "photo"];

export async function extractImageBytes(req: Request): Promise<Uint8Array | null> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();

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
        return new Uint8Array(await v.arrayBuffer());
      }
    }
    // Fallback: take the first Blob field we find.
    for (const [, v] of form.entries()) {
      if (v instanceof Blob && v.size > 0) {
        return new Uint8Array(await v.arrayBuffer());
      }
    }
    return null;
  }

  // image/jpeg, application/octet-stream, or anything else — read raw.
  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return null;
  return new Uint8Array(buf);
}
