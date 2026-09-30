import { describe, expect, it } from "vitest";
import { reelDigits, reelRows, stopSteps } from "../src/reels";

describe("reels", () => {
  it("uses at least 2 reels and one per digit of the max", () => {
    expect(reelDigits(50)).toBe(2);
    expect(reelDigits(9)).toBe(2);
    expect(reelDigits(100)).toBe(3);
    expect(reelDigits(1_000_000)).toBe(7);
  });
  it("stops columns left to right in at most 4 edits", () => {
    expect(stopSteps(2)).toEqual([1, 2]);
    expect(stopSteps(3)).toEqual([1, 2, 3]);
    expect(stopSteps(7)).toEqual([2, 4, 5, 7]);
  });
  it("keeps the reel block within Discord's jumbo emoji limit", () => {
    expect(reelRows([1, 2, 3], 2)).toEqual([1, 2, 3]);
    expect(reelRows(Array.from({ length: 20 }, (_, i) => i), 3)).toHaveLength(9);
  });
});
