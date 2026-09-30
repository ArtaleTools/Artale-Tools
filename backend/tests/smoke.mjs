// End-to-end smoke test against a local `wrangler dev` (workerd + local Durable Objects).
// Starts a mock Discord API, launches wrangler dev with test vars, runs the host/viewer/Discord flows.
// Usage: npm run smoke
import { spawn } from "node:child_process";
import http from "node:http";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 8799;
const MOCK_PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "http://localhost:5500";
const GUILD = "1364050807544090695";
const CHANNEL = "1364050809549225989";

const toHex = (b) => Buffer.from(b).toString("hex");
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const publicKey = toHex(await crypto.subtle.exportKey("raw", kp.publicKey));

// ---- mock Discord API: records webhook edits ----
const edits = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    edits.push({ method: req.method, url: req.url, body: JSON.parse(body || "{}") });
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

const vars = {
  ENVIRONMENT: "development",
  ALLOWED_ORIGINS: `https://artaletools.github.io,${ORIGIN}`,
  DISCORD_PUBLIC_KEY: publicKey,
  DISCORD_APPLICATION_ID: "123456789012345678",
  DISCORD_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
  DRAW_COOLDOWN_SECONDS: "1",
};
// Fresh local state every run so earlier runs cannot affect results.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "artale-smoke-"));
const args = ["wrangler", "dev", "--persist-to", `"${stateDir}"`, "--port", String(PORT), "--ip", "127.0.0.1", "--show-interactive-dev-session=false"];
for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
const dev = spawn("npx", args, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
let devLog = "";
dev.stdout.on("data", (d) => (devLog += d));
dev.stderr.on("data", (d) => (devLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`wrangler dev did not start:\n${devLog}`);
}

const api = (path, init = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...(init.headers ?? {}) } });

function openViewer(roomId) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/rooms/${roomId}/ws`, { headers: { Origin: ORIGIN } });
  const messages = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    messages.push(msg);
    waiters.splice(0).forEach((w) => w());
  };
  const next = async (type) => {
    for (let i = 0; i < 100; i++) {
      const m = messages.find((x) => x.type === type && !x._seen);
      if (m) return (m._seen = true), m;
      await new Promise((r) => { waiters.push(r); setTimeout(r, 100); });
    }
    throw new Error(`no ${type} message`);
  };
  return { ws, next, messages, opened: new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }) };
}

async function signedInteraction(body) {
  const ts = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify(body);
  const sig = toHex(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(ts + raw)));
  return fetch(`${BASE}/discord/interactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signature-Ed25519": sig, "X-Signature-Timestamp": ts },
    body: raw,
  });
}

const results = [];
async function step(name, fn) {
  await fn();
  results.push(name);
  console.log(`✓ ${name}`);
}

try {
  await waitReady();

  let room, hostToken;
  await step("建立房間（development 略過 Turnstile）", async () => {
    const res = await api("/api/rooms", { method: "POST", body: "{}" });
    assert.equal(res.status, 201);
    ({ roomId: room, hostToken } = await res.json());
    assert.match(room, /^[A-Za-z0-9_-]{22}$/);
  });
  const auth = { Authorization: `Bearer ${hostToken}` };

  await step("公開 snapshot 不含秘密", async () => {
    const text = await (await api(`/api/rooms/${room}`)).text();
    assert.ok(!text.includes(hostToken) && !text.includes("host_token"));
  });

  const v1 = openViewer(room);
  const v2 = openViewer(room);
  await Promise.all([v1.opened, v2.opened]);
  await step("觀眾連線立即收到 snapshot", async () => {
    assert.equal((await v1.next("snapshot")).version, 0);
    await v2.next("snapshot");
  });

  const draw = { requestId: crypto.randomUUID(), expectedVersion: 0, min: 1, max: 50, count: 3 };
  let first;
  await step("錯 token／無 token 被拒", async () => {
    assert.equal((await api(`/api/rooms/${room}/draw`, { method: "POST", body: JSON.stringify(draw) })).status, 401);
    const bad = { Authorization: "Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
    assert.equal((await api(`/api/rooms/${room}/draw`, { method: "POST", headers: bad, body: JSON.stringify(draw) })).status, 401);
  });

  await step("房主抽獎，兩位觀眾收到相同結果", async () => {
    const res = await api(`/api/rooms/${room}/draw`, { method: "POST", headers: auth, body: JSON.stringify(draw) });
    assert.equal(res.status, 200);
    first = await res.json();
    const [a, b] = [await v1.next("draw_committed"), await v2.next("draw_committed")];
    assert.deepEqual(a.draw, first.draw);
    assert.deepEqual(b.draw, first.draw);
    assert.equal(first.draw.sequence, 1);
    assert.equal(new Set(first.draw.results).size, 3);
  });

  await step("同 requestId 重試回原結果（不受冷卻限制）", async () => {
    const res = await api(`/api/rooms/${room}/draw`, { method: "POST", headers: auth, body: JSON.stringify(draw) });
    const again = await res.json();
    assert.equal(res.status, 200);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.draw, first.draw);
  });

  await step("同 requestId 不同內容 409", async () => {
    const res = await api(`/api/rooms/${room}/draw`, { method: "POST", headers: auth, body: JSON.stringify({ ...draw, count: 2 }) });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "IDEMPOTENCY_CONFLICT");
  });

  await step("冷卻中 429 並附 Retry-After", async () => {
    const res = await api(`/api/rooms/${room}/draw`, {
      method: "POST", headers: auth, body: JSON.stringify({ ...draw, requestId: crypto.randomUUID(), expectedVersion: 1 }),
    });
    assert.equal(res.status, 429);
    assert.ok(res.headers.get("Retry-After"));
  });

  await sleep(1100);
  await step("過期版本 409 VERSION_CONFLICT", async () => {
    const res = await api(`/api/rooms/${room}/draw`, { method: "POST", headers: auth, body: JSON.stringify({ ...draw, requestId: crypto.randomUUID() }) });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "VERSION_CONFLICT");
  });

  await step("偽造 results 欄位 400", async () => {
    const res = await api(`/api/rooms/${room}/draw`, {
      method: "POST", headers: auth, body: JSON.stringify({ ...draw, requestId: crypto.randomUUID(), expectedVersion: 1, results: [1] }),
    });
    assert.equal(res.status, 400);
  });

  await step("錯誤 Origin 被拒（REST 與 WebSocket）", async () => {
    const res = await fetch(`${BASE}/api/rooms/${room}`, { headers: { Origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${BASE}/api/rooms/${room}/ws`, {
        headers: { Origin: "https://evil.example", Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" },
      });
      req.on("response", (res) => resolve(res.statusCode));
      req.on("upgrade", () => resolve(101));
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  await step("新觀眾 snapshot 含最新結果與歷史", async () => {
    const snap = await (await api(`/api/rooms/${room}`)).json();
    assert.equal(snap.lastSequence, 1);
    assert.deepEqual(snap.latestDraw, first.draw);
    assert.equal(snap.history.length, 1);
  });

  await step("關閉房間：廣播 room_closed，重複關閉成功且不加版本，之後不能抽", async () => {
    const res = await api(`/api/rooms/${room}/close`, { method: "POST", headers: auth });
    const body = await res.json();
    assert.equal(res.status, 200);
    await v1.next("room_closed");
    const again = await (await api(`/api/rooms/${room}/close`, { method: "POST", headers: auth })).json();
    assert.equal(again.version, body.version);
    const d = await api(`/api/rooms/${room}/draw`, {
      method: "POST", headers: auth, body: JSON.stringify({ ...draw, requestId: crypto.randomUUID(), expectedVersion: body.version }),
    });
    assert.equal(d.status, 410);
    const replay = await api(`/api/rooms/${room}/draw`, { method: "POST", headers: auth, body: JSON.stringify(draw) });
    assert.equal(replay.status, 410, "關閉後不允許重試");
    const snap = await (await api(`/api/rooms/${room}`)).json();
    assert.equal(snap.status, "closed");
    assert.equal(snap.history.length, 1);
  });

  await step("不存在的房間 404", async () => {
    assert.equal((await api(`/api/rooms/AAAAAAAAAAAAAAAAAAAAAA`)).status, 404);
  });

  // ---------- Discord ----------
  await step("Discord：錯誤簽章 401、PING 回 PONG", async () => {
    const bad = await fetch(`${BASE}/discord/interactions`, {
      method: "POST",
      headers: { "X-Signature-Ed25519": "00".repeat(64), "X-Signature-Timestamp": String(Math.floor(Date.now() / 1000)) },
      body: '{"type":1}',
    });
    assert.equal(bad.status, 401);
    assert.deepEqual(await (await signedInteraction({ type: 1 })).json(), { type: 1 });
  });

  const interaction = (id, channel = CHANNEL, options = [{ name: "最大", value: 30 }, { name: "數量", value: 2 }]) => ({
    type: 2, id, token: `tok-${id}`, application_id: "123456789012345678", guild_id: GUILD, channel_id: channel,
    data: { name: "抽獎", options }, member: { user: { id: "111111111111111111" } },
  });

  await step("Discord：非指定頻道拒絕（ephemeral）", async () => {
    const body = await (await signedInteraction(interaction("900000000000000001", "999999999999999999"))).json();
    assert.equal(body.data.flags, 64);
  });

  const dcRoom = `dc-${CHANNEL}`;
  const watcher = openViewer(dcRoom);
  await watcher.opened;
  await watcher.next("snapshot");

  let dcDraw;
  await step("Discord：/抽獎 產生結果並廣播到網頁房間", async () => {
    const res = await signedInteraction(interaction("900000000000000002"));
    const body = await res.json();
    assert.equal(body.type, 4);
    assert.match(body.data.embeds[0].title, /轉動中/);
    assert.ok(body.data.embeds[0].image.url.includes("discord-roll.gif"));
    dcDraw = (await watcher.next("draw_committed")).draw;
    assert.equal(dcDraw.source, "discord");
    assert.equal(dcDraw.max, 30);
    assert.equal(dcDraw.results.length, 2);
  });

  await step("Discord：先顯示轉動 GIF，再編輯成同一結果", async () => {
    for (let i = 0; i < 80 && !edits.some((e) => e.body.embeds?.[0]?.title?.includes("恭喜")); i++) await sleep(100);
    const final = edits.find((e) => e.body.embeds?.[0]?.title?.includes("恭喜"));
    assert.ok(final.body.embeds[0].image.url.includes("discord-win.gif"));
    assert.ok(final.url.includes("/webhooks/123456789012345678/tok-900000000000000002/messages/@original"));
    const shown = [...dcDraw.results].sort((a, b) => a - b).join("、");
    assert.ok(final.body.embeds[0].description.includes(shown));
    assert.ok(final.body.components[0].components[0].url.includes(`room=${dcRoom}`));
  });

  await step("Discord：同一 interaction 重送不重抽", async () => {
    await sleep(1100);
    const body = await (await signedInteraction(interaction("900000000000000002"))).json();
    assert.ok(body.data.embeds[0].description.includes([...dcDraw.results].sort((a, b) => a - b).join("、")));
    const snap = await (await api(`/api/rooms/${dcRoom}`)).json();
    assert.equal(snap.lastSequence, 1);
  });

  await step("Discord 房間不能從網頁 API 抽獎", async () => {
    assert.equal((await api(`/api/rooms/${dcRoom}/draw`, { method: "POST", body: "{}" })).status, 403);
  });

  console.log(`\n全部通過：${results.length} 項`);
} catch (e) {
  console.error("✗ 失敗：", e);
  console.error(devLog.split("\n").slice(-30).join("\n"));
  process.exitCode = 1;
} finally {
  mock.close();
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(dev.pid), "/T", "/F"], { stdio: "ignore" });
  else dev.kill();
  setTimeout(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    process.exit();
  }, 1500);
}
