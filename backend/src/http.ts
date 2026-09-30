import type { Room } from "./room";

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  CREATE_LIMITER?: RateLimit;
  CONNECT_LIMITER?: RateLimit;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS: string;
  ROOM_TTL_SECONDS: string;
  CLOSED_ROOM_RETENTION_SECONDS: string;
  MAX_CONNECTIONS_PER_ROOM: string;
  DRAW_COOLDOWN_SECONDS: string;
  MAX_DRAWS_PER_UTC_DAY_PER_ROOM: string;
  TURNSTILE_SECRET?: string;
  PAGES_URL: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_ALLOWED_GUILDS?: string;
  DISCORD_ALLOWED_CHANNELS?: string;
  /** Test hook: override Discord API base (never set in production). */
  DISCORD_API_BASE?: string;
}

export const SCHEMA_VERSION = 1;

export function intVar(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function listVar(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json; charset=utf-8");
  h.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: h });
}

export function errorResponse(status: number, code: string, message: string, headers: HeadersInit = {}): Response {
  return json({ schemaVersion: SCHEMA_VERSION, error: { code, message } }, status, headers);
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public headers: HeadersInit = {},
  ) {
    super(message);
  }
  toResponse(): Response {
    return errorResponse(this.status, this.code, this.message, this.headers);
  }
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "請求內容過大。");
  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "請求內容過大。");
  if (buf.byteLength === 0) return {};
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "JSON 格式錯誤。");
  }
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of equal-length hex digests. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
