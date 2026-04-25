// Two-tier image similarity for PR-cost dedup.
//
// Tier 1 — SHA-256 exact byte match (~2ms)
//   Catches truly byte-identical JPEGs. Milesight's motion trigger often
//   produces these for genuinely stationary scenes (e.g. wind gust on an
//   already-parked trailer). Zero false positives: SHA-256 collisions are
//   astronomically unlikely.
//
// Tier 2 — Difference-hash (dHash) perceptual match (~100ms after decode)
//   Catches same-scene frames that differ in JPEG bytes due to sensor
//   noise, compression variance, sub-pixel lighting shifts. Decodes the
//   JPEG, converts to 9x8 grayscale, produces a 64-bit hash from
//   adjacent-pixel comparisons. Two images with Hamming distance ≤ ~5
//   bits are visually the same scene.
//
// Both hashes get stored on the plate_event so future frames on the same
// camera can match against them.
//
// JPEG decoding via jpeg-js (pure JS, works in Deno edge functions).

import { decode as decodeJpeg } from "https://esm.sh/jpeg-js@0.4.4";

export type ImageHashes = {
  sha256: string;      // 64 hex chars
  dhash: string | null; // 16 hex chars, or null if JPEG decode failed
  // Mean luminance over the downsampled 9x8 grid. 0 = pitch black, 255 =
  // pure white. Useful for skipping pure-black frames before paying for
  // sidecar/PR — observed in prod where the camera sends entirely-dark
  // images at night or with a covered lens.
  meanLuma: number;
};

export async function computeImageHashes(bytes: Uint8Array): Promise<ImageHashes> {
  const sha256 = await sha256Hex(bytes);
  const result = await computeDHashSafe(bytes);
  return { sha256, dhash: result.dhash, meanLuma: result.meanLuma };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function computeDHashSafe(bytes: Uint8Array): Promise<{ dhash: string | null; meanLuma: number }> {
  try {
    // Cap memory usage. Typical Milesight JPEGs decode to 2-8MB of raw
    // RGBA. 50MB is far above that ceiling but guards against malformed
    // headers claiming enormous dimensions.
    const decoded = decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 50 });
    return computeDHash(decoded.data as Uint8Array, decoded.width, decoded.height);
  } catch (err) {
    console.warn("dhash decode failed:", err instanceof Error ? err.message : String(err));
    return { dhash: null, meanLuma: 0 };
  }
}

// Difference hash: resize to 9x8 grayscale, then for each row compare
// adjacent pixels. 8 comparisons × 8 rows = 64 bits.
// Also returns mean luminance over the 9x8 grid for cheap pure-black detection.
function computeDHash(rgba: Uint8Array, width: number, height: number): { dhash: string; meanLuma: number } {
  const grayscale = new Float32Array(72); // 9 columns × 8 rows
  let lumaSum = 0;
  for (let y = 0; y < 8; y++) {
    const srcY = Math.min(height - 1, Math.floor((y * height) / 8));
    for (let x = 0; x < 9; x++) {
      const srcX = Math.min(width - 1, Math.floor((x * width) / 9));
      const idx = (srcY * width + srcX) * 4;
      // Rec. 709 luminance approximation
      const luma = 0.2126 * rgba[idx] + 0.7152 * rgba[idx + 1] + 0.0722 * rgba[idx + 2];
      grayscale[y * 9 + x] = luma;
      lumaSum += luma;
    }
  }
  const hashBytes = new Uint8Array(8);
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) {
      if (grayscale[y * 9 + x] > grayscale[y * 9 + x + 1]) byte |= 1 << (7 - x);
    }
    hashBytes[y] = byte;
  }
  const dhash = Array.from(hashBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { dhash, meanLuma: lumaSum / 72 };
}

// Hamming distance between two hex-encoded hashes of equal length.
// Returns 64 (max) on length mismatch.
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let dist = 0;
  for (let i = 0; i < a.length; i += 2) {
    const x = parseInt(a.substring(i, i + 2), 16);
    const y = parseInt(b.substring(i, i + 2), 16);
    let xor = (x ^ y) & 0xff;
    while (xor) {
      dist += xor & 1;
      xor >>>= 1;
    }
  }
  return dist;
}
