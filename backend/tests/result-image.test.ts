import { describe, expect, it } from "vitest";
import { renderResultPng } from "../src/result-image";

describe("renderResultPng", () => {
  it.each([
    ["one", [14]],
    ["three", [3, 17, 42]],
    ["many", Array.from({ length: 12 }, (_, i) => 100 + i * 7)],
    ["hundred", Array.from({ length: 100 }, (_, i) => 1000 + i)],
  ])("renders %s as a valid PNG quickly", async (name, nums) => {
    const t = performance.now();
    const png = await renderResultPng(nums);
    expect(png.length).toBeLessThan(150_000);
    const ms = performance.now() - t;
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(ms).toBeLessThan(50);
  });
});
