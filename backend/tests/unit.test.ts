import { describe, expect, it } from "vitest";
import { verifyDiscordSignature } from "../src/discord";
import { randomInt, sampleUnique } from "../src/random";
import { ValidationError, parseWebDrawRequest, validateSettings } from "../src/validation";

const seq = (...values: number[]) => {
  let i = 0;
  return () => values[i++];
};

describe("randomInt", () => {
  it("rejects values in the biased tail", () => {
    // range 3: limit = 2^32 - (2^32 % 3) = 4294967295, so 4294967295 is rejected.
    const next = seq(4294967295, 7);
    expect(randomInt(10, 12, next)).toBe(10 + (7 % 3));
  });

  it("handles the smallest allowed range", () => {
    for (let i = 0; i < 50; i++) expect([0, 1]).toContain(randomInt(0, 1));
  });
});

describe("sampleUnique", () => {
  it("returns distinct in-range values", () => {
    const out = sampleUnique(1, 50, 20);
    expect(out).toHaveLength(20);
    expect(new Set(out).size).toBe(20);
    for (const v of out) expect(v >= 1 && v <= 50).toBe(true);
  });

  it("draws the full range when count equals range", () => {
    const out = sampleUnique(0, 99, 100);
    expect([...out].sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it("works on the largest range without allocating it", () => {
    const out = sampleUnique(900_001, 1_000_000, 100);
    expect(new Set(out).size).toBe(100);
  });
});

describe("validation", () => {
  const ok = { requestId: "0f8fad5b-d9cb-469f-a165-70867728950e", expectedVersion: 0, min: 1, max: 50, count: 3 };

  it("accepts a valid request", () => {
    expect(parseWebDrawRequest(ok)).toMatchObject({ min: 1, max: 50, count: 3 });
  });

  it.each([
    ["decimal", { ...ok, min: 1.5 }],
    ["string number", { ...ok, max: "50" }],
    ["NaN", { ...ok, count: Number.NaN }],
    ["Infinity", { ...ok, max: Number.POSITIVE_INFINITY }],
    ["min == max (original rejects)", { ...ok, min: 5, max: 5, count: 1 }],
    ["min > max", { ...ok, min: 9, max: 5 }],
    ["negative", { ...ok, min: -1 }],
    ["over max value", { ...ok, max: 1_000_001 }],
    ["range too large", { ...ok, min: 0, max: 100_000 }],
    ["count > range", { ...ok, min: 1, max: 3, count: 4 }],
    ["count > 100", { ...ok, max: 500, count: 101 }],
    ["forged results", { ...ok, results: [1, 2, 3] }],
    ["allowDuplicates", { ...ok, allowDuplicates: true }],
    ["bad requestId", { ...ok, requestId: "abc" }],
  ])("rejects %s", (_name, body) => {
    expect(() => parseWebDrawRequest(body)).toThrow(ValidationError);
  });

  it("allows the maximum range exactly", () => {
    expect(validateSettings(0, 99_999, 100)).toEqual({ min: 0, max: 99_999, count: 100 });
  });
});

describe("verifyDiscordSignature", () => {
  const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

  it("accepts a valid signature and rejects tampering / stale timestamps", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = toHex(await crypto.subtle.exportKey("raw", kp.publicKey) as ArrayBuffer);
    const now = 1_790_000_000;
    const ts = String(now);
    const body = '{"type":1}';
    const sig = toHex(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(ts + body)));

    expect(await verifyDiscordSignature(pub, sig, ts, body, now)).toBe(true);
    expect(await verifyDiscordSignature(pub, sig, ts, '{"type":2}', now)).toBe(false);
    expect(await verifyDiscordSignature(pub, sig, ts, body, now + 3600)).toBe(false);
    expect(await verifyDiscordSignature(pub, null, ts, body, now)).toBe(false);
    expect(await verifyDiscordSignature(pub, "zz", ts, body, now)).toBe(false);
  });
});
