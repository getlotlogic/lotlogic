// JPEG rotation for cameras physically mounted at a 90°/180° angle.
// Used by the edge function before handing bytes to Plate Recognizer or
// the USDOT/ParkPow OCR fallback — neither service has a rotation knob.

import { Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";

export type RotationDir = "cw" | "ccw" | "180";

export async function rotateJpegBytes(
  bytes: Uint8Array,
  dir: RotationDir,
): Promise<Uint8Array> {
  const img = await Image.decode(bytes);
  const angle = dir === "cw" ? 90 : dir === "ccw" ? 270 : 180;
  img.rotate(angle);
  return await img.encodeJPEG(85);
}
