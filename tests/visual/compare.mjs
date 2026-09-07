#!/usr/bin/env node
/**
 * tests/visual/compare.mjs — the no-op gate.
 *
 * Usage: node visual/compare.mjs [--url=https://…]
 *
 * Runs capture.mjs into visual/current/ (against the same URL, same
 * credentials-or-fallback rules as capture.mjs itself), then diffs every
 * file there against the committed visual/baseline/. Exits 0 if every file
 * matches; exits 1 and lists every differing (or missing/extra) tab
 * otherwise.
 *
 * HTML files are compared as normalized text — byte-for-byte after
 * capture.mjs's normalization, so any remaining difference is a real DOM
 * change.
 *
 * PNG files are compared as raw bytes first (the fast path — two runs of
 * the same page usually produce byte-identical PNGs). If bytes differ —
 * e.g. a different PNG encoder pass reordered chunks or changed metadata
 * with the same pixels — this falls back to decoding both images and
 * counting differing pixels, with a 0-pixel tolerance: any decodable pixel
 * difference still fails the compare.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(__dirname, 'baseline');
const CURRENT = path.join(__dirname, 'current');

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const urlArg = arg('url', undefined);

const captureArgs = [path.join(__dirname, 'capture.mjs'), `--out=${CURRENT}`];
if (urlArg) captureArgs.push(`--url=${urlArg}`);
execFileSync(process.execPath, captureArgs, { stdio: 'inherit' });

// ── minimal PNG decoder (8-bit, non-interlaced — what Playwright emits) ──
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');
  let offset = 8;
  let ihdr = null;
  const idatChunks = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data.readUInt8(8),
        colorType: data.readUInt8(9),
        interlace: data.readUInt8(12),
      };
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 8 + len + 4; // length + type + data + crc
  }
  if (!ihdr) throw new Error('no IHDR');
  if (ihdr.interlace !== 0) throw new Error('interlaced PNG unsupported');
  if (ihdr.bitDepth !== 8) throw new Error(`bit depth ${ihdr.bitDepth} unsupported`);
  const channelsByColorType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByColorType[ihdr.colorType];
  if (ihdr.colorType === 3) throw new Error('palette PNG unsupported');

  const raw = inflateSync(Buffer.concat(idatChunks));
  const bpp = channels; // bytes per pixel at 8-bit depth
  const stride = ihdr.width * channels;
  const pixels = Buffer.alloc(ihdr.height * stride);

  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  };

  for (let y = 0; y < ihdr.height; y++) {
    const lineStart = y * (stride + 1);
    const filterType = raw[lineStart];
    const src = lineStart + 1;
    const dstOff = y * stride;
    const prevDstOff = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[src + x];
      const a = x >= bpp ? pixels[dstOff + x - bpp] : 0;
      const b = y > 0 ? pixels[prevDstOff + x] : 0;
      const c = y > 0 && x >= bpp ? pixels[prevDstOff + x - bpp] : 0;
      let value;
      switch (filterType) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + Math.floor((a + b) / 2); break;
        case 4: value = rawByte + paeth(a, b, c); break;
        default: throw new Error(`unknown filter type ${filterType}`);
      }
      pixels[dstOff + x] = value & 0xff;
    }
  }
  return { width: ihdr.width, height: ihdr.height, channels, pixels };
}

function pngPixelsEqual(a, b) {
  let da, db;
  try {
    da = decodePNG(a);
    db = decodePNG(b);
  } catch (err) {
    // Can't decode (unsupported PNG variant) — don't silently pass a real
    // difference; report it as differing so a human looks at it.
    console.error(`  (PNG decode fallback failed: ${err.message} — treating as differing)`);
    return false;
  }
  if (da.width !== db.width || da.height !== db.height || da.channels !== db.channels) return false;
  let diffPixels = 0;
  const pxSize = da.channels;
  const count = da.pixels.length / pxSize;
  for (let i = 0; i < count; i++) {
    const off = i * pxSize;
    for (let c = 0; c < pxSize; c++) {
      if (da.pixels[off + c] !== db.pixels[off + c]) { diffPixels++; break; }
    }
  }
  if (diffPixels > 0) console.error(`  (${diffPixels} differing pixel(s) out of ${count})`);
  return diffPixels === 0; // 0-pixel tolerance
}

// ── diff baseline vs current ─────────────────────────────────────────────
const baseFiles = new Set(readdirSync(BASELINE).filter((f) => f !== 'manifest.json'));
const curFiles = new Set(readdirSync(CURRENT).filter((f) => f !== 'manifest.json'));

const missing = [...baseFiles].filter((f) => !curFiles.has(f)).sort();
const extra = [...curFiles].filter((f) => !baseFiles.has(f)).sort();
const differing = [];

for (const f of [...baseFiles].filter((f) => curFiles.has(f)).sort()) {
  const a = readFileSync(path.join(BASELINE, f));
  const b = readFileSync(path.join(CURRENT, f));
  if (f.endsWith('.png')) {
    if (a.equals(b)) continue;
    console.error(`PNG bytes differ, checking pixels: ${f}`);
    if (!pngPixelsEqual(a, b)) differing.push(f);
  } else {
    if (!a.equals(b)) differing.push(f);
  }
}

if (missing.length === 0 && extra.length === 0 && differing.length === 0) {
  console.log(`visual:check OK — ${baseFiles.size} file(s) match ${BASELINE}`);
  process.exit(0);
}

console.error('visual:check FAILED');
if (missing.length) console.error(`  missing (in baseline, not in current): ${missing.join(', ')}`);
if (extra.length) console.error(`  extra (in current, not in baseline): ${extra.join(', ')}`);
if (differing.length) console.error(`  differing: ${differing.join(', ')}`);
process.exit(1);
