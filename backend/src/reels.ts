import EMOJIS from "./emojis.json";

/**
 * Slot-reel rendering with application emojis (lt_0 … lt_9 static digits, lt_spin1 … lt_spin3 spinning).
 * Reels live in the embed description; each row is a "# " heading so the emojis render at heading size.
 */

type EmojiMap = Record<string, { id: string; animated: boolean }>;
const emojis = EMOJIS as EmojiMap;
const SPINS = ["lt_spin1", "lt_spin2", "lt_spin3"];

// Discord only enlarges emoji-only messages up to this many emojis.
const MAX_JUMBO_EMOJIS = 27;

export function reelsAvailable(): boolean {
  return [...Array(10).keys()].every((d) => emojis[`lt_${d}`]) && SPINS.every((s) => emojis[s]);
}

function tag(name: string): string {
  const e = emojis[name];
  return `<${e.animated ? "a" : ""}:${name}:${e.id}>`;
}

export function reelDigits(max: number): number {
  return Math.max(2, String(max).length);
}

/** Numbers shown on reels (the embed always lists all of them). */
export function reelRows(sortedNumbers: number[], digits: number): number[] {
  return sortedNumbers.slice(0, Math.max(1, Math.floor(MAX_JUMBO_EMOJIS / digits)));
}

/** Reel content with the first `stopped` columns showing their final digits, the rest spinning. */
export function reelContent(rows: number[], digits: number, stopped: number): string {
  return rows
    .map((n, r) => {
      const s = String(n).padStart(digits, "0");
      return [...s].map((ch, c) => (c < stopped ? tag(`lt_${ch}`) : tag(SPINS[(r + c) % SPINS.length]))).join("");
    })
    .map((row) => `# ${row}`)
    .join("\n");
}

/** Column counts after each stop edit (at most 4 edits, left to right). */
export function stopSteps(digits: number): number[] {
  const edits = Math.min(digits, 4);
  return [...Array(edits).keys()].map((i) => Math.round(((i + 1) * digits) / edits));
}
