import { DurableObject } from "cloudflare:workers";
import { type Env, HttpError, SCHEMA_VERSION, intVar, json, readJsonBody, sha256Hex, timingSafeEqualHex } from "./http";
import { sampleUnique } from "./random";
import { DEFAULT_SETTINGS, type DrawSettings, LIMITS, ValidationError, parseWebDrawRequest, validateSettings } from "./validation";

type RoomKind = "web" | "discord";
type RoomStatus = "open" | "closed" | "expired";
type DrawSource = "web" | "discord";

interface RoomRow {
  room_id: string;
  kind: RoomKind;
  host_token_hash: string | null;
  status: RoomStatus;
  created_at: string;
  expires_at: string | null;
  closed_at: string | null;
  version: number;
  last_sequence: number;
  settings_json: string;
  day_key: string;
  day_count: number;
  last_draw_at: number;
  [key: string]: SqlStorageValue;
}

interface DrawRow {
  id: string;
  sequence: number;
  request_id: string;
  request_hash: string;
  source: DrawSource;
  settings_json: string;
  results_json: string;
  created_at: string;
  [key: string]: SqlStorageValue;
}

export interface DrawOut extends DrawSettings {
  id: string;
  sequence: number;
  requestId: string;
  source: DrawSource;
  results: number[];
  createdAt: string;
}

export interface DrawCommitted {
  schemaVersion: number;
  type: "draw_committed";
  roomId: string;
  version: number;
  draw: DrawOut;
  replayed?: boolean;
}

const HISTORY_LIMIT = 100;

function toDraw(row: DrawRow): DrawOut {
  const settings = JSON.parse(row.settings_json) as DrawSettings;
  return {
    id: row.id,
    sequence: row.sequence,
    requestId: row.request_id,
    source: row.source,
    ...settings,
    results: JSON.parse(row.results_json) as number[],
    createdAt: row.created_at,
  };
}

/**
 * One Durable Object per room. Every state change happens inside a synchronous section
 * (no `await` between reading state and `transactionSync`), so concurrent requests cannot interleave.
 */
export class Room extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS room (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          room_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          host_token_hash TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          closed_at TEXT,
          version INTEGER NOT NULL DEFAULT 0,
          last_sequence INTEGER NOT NULL DEFAULT 0,
          settings_json TEXT NOT NULL,
          day_key TEXT NOT NULL DEFAULT '',
          day_count INTEGER NOT NULL DEFAULT 0,
          last_draw_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS draws (
          id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL UNIQUE,
          request_id TEXT NOT NULL UNIQUE,
          request_hash TEXT NOT NULL,
          source TEXT NOT NULL,
          settings_json TEXT NOT NULL,
          results_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---------- helpers ----------

  private getRoom(): RoomRow | undefined {
    return this.sql.exec<RoomRow>("SELECT * FROM room WHERE id = 1").toArray()[0];
  }

  private history(): DrawOut[] {
    return this.sql
      .exec<DrawRow>("SELECT * FROM draws ORDER BY sequence DESC LIMIT ?", HISTORY_LIMIT)
      .toArray()
      .map(toDraw);
  }

  private snapshot(room: RoomRow) {
    const history = this.history();
    return {
      schemaVersion: SCHEMA_VERSION,
      type: "snapshot" as const,
      roomId: room.room_id,
      kind: room.kind,
      status: room.status,
      version: room.version,
      lastSequence: room.last_sequence,
      settings: JSON.parse(room.settings_json) as DrawSettings,
      latestDraw: history[0] ?? null,
      history,
      expiresAt: room.expires_at,
      connections: this.ctx.getWebSockets().length,
    };
  }

  private broadcast(message: unknown): void {
    const data = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // A failed send never invalidates a committed result; the client resyncs from snapshot.
      }
    }
  }

  private closeAllSockets(code: number, reason: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(code, reason);
      } catch {
        /* already closed */
      }
    }
  }

  private retentionMs(): number {
    return intVar(this.env.CLOSED_ROOM_RETENTION_SECONDS, 7 * 86400) * 1000;
  }

  /** Applies TTL / retention transitions. Keeps a tombstone row so the id can never be recreated. */
  private refreshExpiry(room: RoomRow, now: number): RoomRow {
    const ttlDue = room.status === "open" && room.expires_at !== null && Date.parse(room.expires_at) <= now;
    const retentionDue =
      room.status === "closed" && room.closed_at !== null && Date.parse(room.closed_at) + this.retentionMs() <= now;
    if (!ttlDue && !retentionDue) return room;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM draws");
      this.sql.exec("UPDATE room SET status = 'expired', host_token_hash = NULL WHERE id = 1");
    });
    this.broadcast({ schemaVersion: SCHEMA_VERSION, type: "room_expired", roomId: room.room_id });
    this.closeAllSockets(1000, "room expired");
    return this.getRoom()!;
  }

  private requireLiveRoom(now: number): RoomRow {
    const found = this.getRoom();
    if (!found) throw new HttpError(404, "ROOM_NOT_FOUND", "找不到房間。");
    const room = this.refreshExpiry(found, now);
    if (room.status === "expired") throw new HttpError(410, "ROOM_EXPIRED", "房間已過期。");
    return room;
  }

  private checkHost(room: RoomRow, tokenHash: string | null): void {
    if (room.kind !== "web" || !room.host_token_hash || !tokenHash || !timingSafeEqualHex(room.host_token_hash, tokenHash)) {
      throw new HttpError(401, "UNAUTHORIZED", "房主驗證失敗。");
    }
  }

  private async bearerHash(request: Request): Promise<string | null> {
    const auth = request.headers.get("Authorization") ?? "";
    const m = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(auth);
    return m ? sha256Hex(m[1]) : null;
  }

  private enforceLimits(room: RoomRow, now: number): void {
    const cooldownMs = intVar(this.env.DRAW_COOLDOWN_SECONDS, 2) * 1000;
    const wait = room.last_draw_at + cooldownMs - now;
    if (wait > 0) {
      throw new HttpError(429, "COOLDOWN", "抽獎太頻繁，請稍候再試。", { "Retry-After": String(Math.ceil(wait / 1000)) });
    }
    const today = new Date(now).toISOString().slice(0, 10);
    const used = room.day_key === today ? room.day_count : 0;
    if (used >= intVar(this.env.MAX_DRAWS_PER_UTC_DAY_PER_ROOM, 500)) {
      throw new HttpError(429, "DAILY_LIMIT", "今日抽獎次數已達上限（UTC 00:00 重置）。");
    }
  }

  /** Idempotency lookup: same requestId + same payload replays, different payload conflicts. */
  private findReplay(requestId: string, requestHash: string): DrawOut | null {
    const row = this.sql.exec<DrawRow>("SELECT * FROM draws WHERE request_id = ?", requestId).toArray()[0];
    if (!row) return null;
    if (row.request_hash !== requestHash) {
      throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "相同 requestId 已用於不同內容。");
    }
    return toDraw(row);
  }

  private commitDraw(room: RoomRow, settings: DrawSettings, requestId: string, requestHash: string, source: DrawSource, now: number): DrawCommitted {
    const results = sampleUnique(settings.min, settings.max, settings.count);
    const sequence = room.last_sequence + 1;
    const version = room.version + 1;
    const createdAt = new Date(now).toISOString();
    const today = createdAt.slice(0, 10);
    const dayCount = (room.day_key === today ? room.day_count : 0) + 1;
    const draw: DrawOut = { id: crypto.randomUUID(), sequence, requestId, source, ...settings, results, createdAt };
    const settingsJson = JSON.stringify(settings);

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO draws (id, sequence, request_id, request_hash, source, settings_json, results_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        draw.id, sequence, requestId, requestHash, source, settingsJson, JSON.stringify(results), createdAt,
      );
      this.sql.exec(
        `UPDATE room SET version = ?, last_sequence = ?, settings_json = ?, day_key = ?, day_count = ?, last_draw_at = ?
         WHERE id = 1`,
        version, sequence, settingsJson, today, dayCount, now,
      );
      this.sql.exec("DELETE FROM draws WHERE sequence <= ?", sequence - HISTORY_LIMIT);
    });

    const message: DrawCommitted = { schemaVersion: SCHEMA_VERSION, type: "draw_committed", roomId: room.room_id, version, draw };
    this.broadcast(message);
    return message;
  }

  /** Discord channel rooms are permanent and created on first use (the Worker only calls this for allowed channels). */
  private ensureDiscordRoom(roomId: string, now: number): void {
    if (this.getRoom()) return;
    this.sql.exec(
      `INSERT INTO room (id, room_id, kind, status, created_at, settings_json) VALUES (1, ?, 'discord', 'open', ?, ?)`,
      roomId, new Date(now).toISOString(), JSON.stringify(DEFAULT_SETTINGS),
    );
  }

  // ---------- routes (internal: only reachable through the Worker router) ----------

  async fetch(request: Request): Promise<Response> {
    try {
      const { pathname } = new URL(request.url);
      const discordRoom = request.headers.get("X-Ensure-Discord-Room");
      if (discordRoom) this.ensureDiscordRoom(discordRoom, Date.now());
      switch (`${request.method} ${pathname}`) {
        case "POST /init":
          return await this.handleInit(request);
        case "GET /snapshot":
          return json(this.snapshot(this.requireLiveRoom(Date.now())));
        case "GET /ws":
          return this.handleWebSocket(request);
        case "POST /draw":
          return await this.handleWebDraw(request);
        case "POST /discord-draw":
          return await this.handleDiscordDraw(request);
        case "POST /close":
          return await this.handleClose(request);
        default:
          throw new HttpError(404, "NOT_FOUND", "找不到路徑。");
      }
    } catch (e) {
      if (e instanceof HttpError) return e.toResponse();
      if (e instanceof ValidationError) return new HttpError(400, "INVALID_INPUT", e.message).toResponse();
      console.error("room error", e instanceof Error ? e.message : "unknown");
      return new HttpError(500, "INTERNAL", "伺服器錯誤。").toResponse();
    }
  }

  private async handleInit(request: Request): Promise<Response> {
    const body = (await readJsonBody(request, 1024)) as { roomId: string; hostTokenHash: string };
    if (this.getRoom()) throw new HttpError(409, "ROOM_EXISTS", "房間已存在。");
    const now = Date.now();
    const expiresAt = new Date(now + intVar(this.env.ROOM_TTL_SECONDS, 86400) * 1000).toISOString();
    this.sql.exec(
      `INSERT INTO room (id, room_id, kind, host_token_hash, status, created_at, expires_at, settings_json)
       VALUES (1, ?, 'web', ?, 'open', ?, ?, ?)`,
      body.roomId, body.hostTokenHash, new Date(now).toISOString(), expiresAt, JSON.stringify(DEFAULT_SETTINGS),
    );
    await this.ctx.storage.setAlarm(Date.parse(expiresAt));
    return json({ schemaVersion: SCHEMA_VERSION, version: 0, expiresAt }, 201);
  }

  private handleWebSocket(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      throw new HttpError(426, "UPGRADE_REQUIRED", "需要 WebSocket 連線。");
    }
    const room = this.requireLiveRoom(Date.now());
    if (room.status === "closed") throw new HttpError(410, "ROOM_CLOSED", "房間已關閉。");
    const max = intVar(this.env.MAX_CONNECTIONS_PER_ROOM, 100);
    if (this.ctx.getWebSockets().length >= max) {
      throw new HttpError(429, "ROOM_FULL", "房間觀看人數已滿。", { "Retry-After": "30" });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ connectedAt: Date.now() });
    server.send(JSON.stringify(this.snapshot(room)));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleWebDraw(request: Request): Promise<Response> {
    // All async work (body, hashing) happens before the synchronous critical section.
    const tokenHash = await this.bearerHash(request);
    const req = parseWebDrawRequest(await readJsonBody(request, LIMITS.MAX_BODY_BYTES));
    const requestHash = await sha256Hex(JSON.stringify([req.expectedVersion, req.min, req.max, req.count]));

    const now = Date.now();
    const room = this.requireLiveRoom(now);
    this.checkHost(room, tokenHash);
    if (room.status === "closed") throw new HttpError(410, "ROOM_CLOSED", "房間已關閉。");
    const replay = this.findReplay(req.requestId, requestHash);
    if (replay) {
      return json({ schemaVersion: SCHEMA_VERSION, type: "draw_committed", roomId: room.room_id, version: room.version, draw: replay, replayed: true });
    }
    if (req.expectedVersion !== room.version) {
      throw new HttpError(409, "VERSION_CONFLICT", "房間狀態已更新，請重新同步。");
    }
    this.enforceLimits(room, now);
    return json(this.commitDraw(room, req, req.requestId, requestHash, "web", now));
  }

  private async handleDiscordDraw(request: Request): Promise<Response> {
    const body = (await readJsonBody(request, LIMITS.MAX_BODY_BYTES)) as { roomId: string; requestId: string; min: unknown; max: unknown; count: unknown };
    const settings = validateSettings(body.min, body.max, body.count);
    const requestHash = await sha256Hex(JSON.stringify([settings.min, settings.max, settings.count]));

    const now = Date.now();
    this.ensureDiscordRoom(body.roomId, now);
    const room = this.requireLiveRoom(now);
    if (room.kind !== "discord") throw new HttpError(403, "FORBIDDEN", "此房間不接受 Discord 抽獎。");
    const replay = this.findReplay(body.requestId, requestHash);
    if (replay) {
      return json({ schemaVersion: SCHEMA_VERSION, type: "draw_committed", roomId: room.room_id, version: room.version, draw: replay, replayed: true });
    }
    this.enforceLimits(room, now);
    return json(this.commitDraw(room, settings, body.requestId, requestHash, "discord", now));
  }

  private async handleClose(request: Request): Promise<Response> {
    const tokenHash = await this.bearerHash(request);
    const now = Date.now();
    const room = this.requireLiveRoom(now);
    this.checkHost(room, tokenHash);
    if (room.status === "closed") {
      return json({ schemaVersion: SCHEMA_VERSION, status: "closed", version: room.version });
    }
    const closedAt = new Date(now).toISOString();
    const version = room.version + 1;
    this.sql.exec("UPDATE room SET status = 'closed', closed_at = ?, version = ? WHERE id = 1", closedAt, version);
    this.broadcast({ schemaVersion: SCHEMA_VERSION, type: "room_closed", roomId: room.room_id, version });
    this.closeAllSockets(1000, "room closed");
    await this.ctx.storage.setAlarm(now + this.retentionMs());
    return json({ schemaVersion: SCHEMA_VERSION, status: "closed", version });
  }

  // ---------- lifecycle ----------

  async alarm(): Promise<void> {
    const found = this.getRoom();
    if (!found) return;
    const room = this.refreshExpiry(found, Date.now());
    // Re-arm if the alarm fired early (clock skew) and the room is still pending cleanup.
    if (room.status === "open" && room.expires_at) await this.ctx.storage.setAlarm(Date.parse(room.expires_at));
    if (room.status === "closed" && room.closed_at) await this.ctx.storage.setAlarm(Date.parse(room.closed_at) + this.retentionMs());
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Viewers are read-only; "ping" is answered by the auto-response without waking the object.
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }
}
