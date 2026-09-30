import { CHARS, IMAGES, NUM_BOX, PALETTE } from "./result-assets";

/**
 * Renders the result card ("恭喜中獎！" + winning numbers in the page's lucky-text style) as an
 * 8-bit palette PNG. Glyphs and the card were captured from the live page; here we only paste
 * pre-rendered pixels and compress with the runtime's native CompressionStream, which keeps CPU
 * time low enough for the Workers Free plan and the file small enough for Discord to load quickly.
 */

interface Bitmap {
  w: number;
  h: number;
  px: Uint8Array;
  bg: number;
}

let decoded: Map<string, Bitmap> | null = null;
let palette: Uint8Array | null = null;

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function unRle(data: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let o = 0;
  for (let i = 0; i < data.length; i += 2) {
    out.fill(data[i + 1], o, o + data[i]);
    o += data[i];
  }
  return out;
}

function assets(): Map<string, Bitmap> {
  if (decoded) return decoded;
  decoded = new Map();
  for (const [key, [w, h, data]] of Object.entries(IMAGES)) {
    const px = unRle(b64(data), w * h);
    decoded.set(key, { w, h, px, bg: px[0] });
  }
  palette = b64(PALETTE);
  return decoded;
}

// Decode once at isolate startup so request CPU time only covers compositing + PNG writing.
assets();

const SIZES = ["L", "M", "S"] as const;

/** Splits sorted numbers into lines of glyph keys that fit the number box for the largest possible size. */
function layout(numbers: number[]): { size: string; lines: string[][] } {
  const tokens = numbers.map((n, i) => [...String(n)].concat(i < numbers.length - 1 ? ["、"] : []));
  const imgs = assets();
  for (const size of SIZES) {
    const g = imgs.get(`${size}0`)!;
    const perLine = Math.floor(NUM_BOX.w / g.w);
    const maxLines = Math.floor(NUM_BOX.h / g.h);
    const lines: string[][] = [];
    let cur: string[] = [];
    for (const t of tokens) {
      if (cur.length + t.length > perLine && cur.length > 0) {
        lines.push(cur);
        cur = [];
      }
      cur = cur.concat(t);
    }
    if (cur.length) lines.push(cur);
    if (lines.length <= maxLines) return { size, lines };
    if (size === "S") {
      // Too many numbers for the card: show what fits and end with "…" (Discord text lists them all).
      const kept = lines.slice(0, maxLines);
      const last = kept[maxLines - 1];
      while (last.length > perLine - 1) last.pop();
      last.push("…");
      return { size, lines: kept };
    }
  }
  throw new Error("unreachable");
}

function blit(dst: Uint8Array, dstW: number, src: Bitmap, x0: number, y0: number): void {
  for (let y = 0; y < src.h; y++) {
    const row = (y0 + y) * dstW + x0;
    const srow = y * src.w;
    for (let x = 0; x < src.w; x++) {
      const v = src.px[srow + x];
      if (v !== src.bg) dst[row + x] = v; // transparent where the glyph shows plain card background
    }
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  const typeBytes = new TextEncoder().encode(type);
  out.set(typeBytes, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32([typeBytes, data]));
  return out;
}

async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  // "deflate" = zlib-wrapped deflate, exactly what PNG IDAT expects. Runs natively in the runtime.
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function encodePng(w: number, h: number, px: Uint8Array, pal: Uint8Array): Promise<Uint8Array> {
  // Raw scanlines with filter byte 0.
  const raw = new Uint8Array(h * (w + 1));
  for (let y = 0; y < h; y++) raw.set(px.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  const z = await zlibDeflate(raw);

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // palette
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("PLTE", pal), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

export async function renderResultPng(results: number[]): Promise<Uint8Array> {
  const imgs = assets();
  const tpl = imgs.get("template")!;
  const px = tpl.px.slice();
  const sorted = [...results].sort((a, b) => a - b);
  const { size, lines } = layout(sorted);
  const g = imgs.get(`${size}0`)!;
  const blockH = lines.length * g.h;
  let y = NUM_BOX.y + Math.round((NUM_BOX.h - blockH) / 2);
  for (const line of lines) {
    let x = NUM_BOX.x + Math.round((NUM_BOX.w - line.length * g.w) / 2);
    for (const ch of line) {
      blit(px, tpl.w, imgs.get(`${size}${CHARS.indexOf(ch)}`)!, x, y);
      x += g.w;
    }
    y += g.h;
  }
  return encodePng(tpl.w, tpl.h, px, palette!);
}
