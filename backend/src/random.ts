export type Uint32Source = () => number;

export const cryptoUint32: Uint32Source = () => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0];
};

const TWO_32 = 0x1_0000_0000;

/** Unbiased integer in [min, max] via rejection sampling (range must be <= 2^32). */
export function randomInt(min: number, max: number, next: Uint32Source = cryptoUint32): number {
  const range = max - min + 1;
  if (!Number.isSafeInteger(range) || range < 1 || range > TWO_32) throw new RangeError("invalid range");
  // Largest multiple of range that fits in 2^32; values at or above it would bias the modulo.
  const limit = TWO_32 - (TWO_32 % range);
  for (;;) {
    const x = next();
    if (x < limit) return min + (x % range);
  }
}

/** `count` distinct integers from [min, max] in draw order (partial Fisher–Yates on a sparse Map). */
export function sampleUnique(min: number, max: number, count: number, next: Uint32Source = cryptoUint32): number[] {
  const n = max - min + 1;
  if (count < 1 || count > n) throw new RangeError("invalid count");
  const swapped = new Map<number, number>();
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const j = randomInt(i, n - 1, next);
    const vj = swapped.get(j) ?? j;
    const vi = swapped.get(i) ?? i;
    swapped.set(j, vi);
    out.push(min + vj);
  }
  return out;
}
