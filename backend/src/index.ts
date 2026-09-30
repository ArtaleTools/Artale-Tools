import { discordRoomId, handleDiscordInteraction, isAllowedDiscordChannel } from "./discord";
import { renderResultPng } from "./result-image";
import type { DrawOut } from "./room";
import { type Env, HttpError, SCHEMA_VERSION, json, listVar, randomToken, readJsonBody, sha256Hex } from "./http";
import { isDiscordRoomId, isValidRoomId } from "./validation";

export { Room } from "./room";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  if (!origin || !listVar(env.ALLOWED_ORIGINS).includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withCors(res: Response, cors: Record<string, string>): Response {
  if (res.status === 101 || Object.keys(cors).length === 0) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}

async function limit(limiter: RateLimit | undefined, key: string): Promise<void> {
  if (!limiter) return;
  const { success } = await limiter.limit({ key });
  if (!success) throw new HttpError(429, "RATE_LIMITED", "操作太頻繁，請稍後再試。", { "Retry-After": "60" });
}

async function verifyTurnstile(env: Env, token: unknown, ip: string): Promise<void> {
  if (env.ENVIRONMENT === "development") return; // explicit local-only bypass
  if (!env.TURNSTILE_SECRET) throw new HttpError(503, "TURNSTILE_NOT_CONFIGURED", "建立房間暫時無法使用。");
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    throw new HttpError(400, "TURNSTILE_REQUIRED", "請先完成人機驗證。");
  }
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  form.append("remoteip", ip);
  let ok = false;
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: form });
    ok = res.ok && ((await res.json()) as { success?: boolean }).success === true;
  } catch {
    throw new HttpError(503, "TURNSTILE_UNAVAILABLE", "人機驗證服務暫時無法使用。");
  }
  if (!ok) throw new HttpError(403, "TURNSTILE_FAILED", "人機驗證失敗，請重試。");
}

async function createRoom(request: Request, env: Env, ip: string): Promise<Response> {
  await limit(env.CREATE_LIMITER, `create:${ip}`);
  const body = (await readJsonBody(request, 8 * 1024)) as { turnstileToken?: unknown };
  await verifyTurnstile(env, body.turnstileToken, ip);

  const roomId = randomToken(16); // 128-bit, 22 chars base64url
  const hostToken = randomToken(32); // 256-bit
  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  const res = await stub.fetch("https://room/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, hostTokenHash: await sha256Hex(hostToken) }),
  });
  if (!res.ok) return res;
  const init = (await res.json()) as { version: number; expiresAt: string };
  return json({ schemaVersion: SCHEMA_VERSION, roomId, hostToken, version: init.version, expiresAt: init.expiresAt }, 201);
}

function roomStub(env: Env, roomId: string): { stub: DurableObjectStub; headers: Headers } {
  const headers = new Headers();
  if (isDiscordRoomId(roomId)) {
    const channelId = roomId.slice(3);
    const guild = listVar(env.DISCORD_ALLOWED_GUILDS)[0];
    if (!isAllowedDiscordChannel(env, guild, channelId) || discordRoomId(channelId) !== roomId) {
      throw new HttpError(404, "ROOM_NOT_FOUND", "找不到房間。");
    }
    headers.set("X-Ensure-Discord-Room", roomId);
  }
  return { stub: env.ROOMS.get(env.ROOMS.idFromName(roomId)), headers };
}

async function routeApi(request: Request, env: Env, url: URL, ip: string): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const method = request.method;

  if (parts.length === 2 && parts[1] === "health" && method === "GET") {
    return json({ schemaVersion: SCHEMA_VERSION, ok: true });
  }
  if (parts.length === 2 && parts[1] === "rooms") {
    if (method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "不允許的方法。");
    return createRoom(request, env, ip);
  }
  if (parts[1] !== "rooms" || parts.length < 3 || parts.length > 4) throw new HttpError(404, "NOT_FOUND", "找不到路徑。");

  const roomId = parts[2];
  if (!isValidRoomId(roomId)) throw new HttpError(404, "ROOM_NOT_FOUND", "找不到房間。");
  const action = parts[3] ?? "";
  const { stub, headers } = roomStub(env, roomId);

  if (action === "" && method === "GET") {
    return stub.fetch("https://room/snapshot", { headers });
  }
  if (action === "ws" && method === "GET") {
    const origin = request.headers.get("Origin");
    if (!origin || !listVar(env.ALLOWED_ORIGINS).includes(origin)) throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "來源不被允許。");
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      throw new HttpError(426, "UPGRADE_REQUIRED", "需要 WebSocket 連線。");
    }
    await limit(env.CONNECT_LIMITER, `ws:${ip}`);
    const fwd = new Headers(headers);
    for (const h of ["Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Extensions"]) {
      const v = request.headers.get(h);
      if (v) fwd.set(h, v);
    }
    return stub.fetch("https://room/ws", { headers: fwd });
  }
  if ((action === "draw" || action === "close") && method === "POST") {
    if (isDiscordRoomId(roomId)) throw new HttpError(403, "FORBIDDEN", "Discord 房間只能在 Discord 使用 /抽獎。");
    const fwd = new Headers({ "Content-Type": "application/json" });
    const auth = request.headers.get("Authorization");
    if (auth) fwd.set("Authorization", auth);
    return stub.fetch(`https://room/${action}`, { method: "POST", headers: fwd, body: request.body });
  }
  throw new HttpError(405, "METHOD_NOT_ALLOWED", "不允許的方法。");
}

/** Result card PNG for one committed draw (used as the Discord embed image). */
async function resultImage(env: Env, roomId: string, sequence: number): Promise<Response> {
  if (!isValidRoomId(roomId)) throw new HttpError(404, "NOT_FOUND", "找不到圖片。");
  const { stub, headers } = roomStub(env, roomId);
  const res = await stub.fetch("https://room/snapshot", { headers });
  if (!res.ok) throw new HttpError(404, "NOT_FOUND", "找不到圖片。");
  const snap = (await res.json()) as { history: DrawOut[] };
  const draw = snap.history.find((d) => d.sequence === sequence);
  if (!draw) throw new HttpError(404, "NOT_FOUND", "找不到圖片。");
  return new Response(await renderResultPng(draw.results), {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";

    if (url.pathname === "/discord/interactions") {
      try {
        if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "不允許的方法。");
        return await handleDiscordInteraction(request, env, ctx);
      } catch (e) {
        if (e instanceof HttpError) return e.toResponse();
        console.error("discord error", e instanceof Error ? e.message : "unknown");
        return new HttpError(500, "INTERNAL", "伺服器錯誤。").toResponse();
      }
    }

    const img = /^\/img\/result\/([A-Za-z0-9_-]+)\/(\d{1,9})\.png$/.exec(url.pathname);
    if (img && request.method === "GET") {
      try {
        return await resultImage(env, img[1], Number(img[2]));
      } catch (e) {
        if (e instanceof HttpError) return e.toResponse();
        console.error("image error", e instanceof Error ? e.message : "unknown");
        return new HttpError(500, "INTERNAL", "伺服器錯誤。").toResponse();
      }
    }

    if (!url.pathname.startsWith("/api/")) return new HttpError(404, "NOT_FOUND", "找不到路徑。").toResponse();

    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env);
    if (origin && Object.keys(cors).length === 0) {
      return new HttpError(403, "ORIGIN_NOT_ALLOWED", "來源不被允許。").toResponse();
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      return withCors(await routeApi(request, env, url, ip), cors);
    } catch (e) {
      if (e instanceof HttpError) return withCors(e.toResponse(), cors);
      console.error("api error", e instanceof Error ? e.message : "unknown");
      return withCors(new HttpError(500, "INTERNAL", "伺服器錯誤。").toResponse(), cors);
    }
  },
} satisfies ExportedHandler<Env>;
