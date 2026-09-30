export const LIMITS = {
  MIN_VALUE: 0,
  MAX_VALUE: 1_000_000,
  MAX_RANGE: 100_000,
  MAX_COUNT: 100,
  MAX_BODY_BYTES: 8 * 1024,
} as const;

export const DEFAULT_SETTINGS = { min: 1, max: 50, count: 1 } as const;

export interface DrawSettings {
  min: number;
  max: number;
  count: number;
}

export interface WebDrawRequest extends DrawSettings {
  requestId: string;
  expectedVersion: number;
}

export class ValidationError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEB_ROOM_RE = /^[A-Za-z0-9_-]{22}$/;
const DISCORD_ROOM_RE = /^dc-\d{15,21}$/;

export function isValidRoomId(id: string): boolean {
  return WEB_ROOM_RE.test(id) || DISCORD_ROOM_RE.test(id);
}

export function isDiscordRoomId(id: string): boolean {
  return DISCORD_ROOM_RE.test(id);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** Validates min/max/count with the same rules as the original page (min < max, no duplicates). */
export function validateSettings(min: unknown, max: unknown, count: unknown): DrawSettings {
  if (!isInt(min) || !isInt(max) || !isInt(count)) throw new ValidationError("最小、最大、數量都必須是整數。");
  if (min < LIMITS.MIN_VALUE || max > LIMITS.MAX_VALUE) {
    throw new ValidationError(`範圍必須介於 ${LIMITS.MIN_VALUE} 到 ${LIMITS.MAX_VALUE}。`);
  }
  if (min >= max) throw new ValidationError("範圍(小) 必須小於 範圍(大)。");
  const range = max - min + 1;
  if (range > LIMITS.MAX_RANGE) throw new ValidationError(`區間最多 ${LIMITS.MAX_RANGE} 個號碼。`);
  if (count < 1 || count > LIMITS.MAX_COUNT) throw new ValidationError(`抽取數量必須介於 1 到 ${LIMITS.MAX_COUNT}。`);
  if (count > range) throw new ValidationError("抽取數量不能超過區間內的號碼數。");
  return { min, max, count };
}

const WEB_DRAW_KEYS = new Set(["requestId", "expectedVersion", "min", "max", "count"]);

export function parseWebDrawRequest(body: unknown): WebDrawRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ValidationError("請求格式錯誤。");
  const obj = body as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!WEB_DRAW_KEYS.has(key)) throw new ValidationError(`不允許的欄位：${key}`);
  }
  if (typeof obj.requestId !== "string" || !UUID_RE.test(obj.requestId)) throw new ValidationError("requestId 必須是 UUID。");
  if (!isInt(obj.expectedVersion) || obj.expectedVersion < 0) throw new ValidationError("expectedVersion 無效。");
  const settings = validateSettings(obj.min, obj.max, obj.count);
  return { requestId: obj.requestId.toLowerCase(), expectedVersion: obj.expectedVersion, ...settings };
}
