import { type Env, HttpError, json, listVar } from "./http";
import type { DrawCommitted } from "./room";
import { reelContent, reelDigits, reelRows, reelsAvailable, stopSteps } from "./reels";
import { DEFAULT_SETTINGS } from "./validation";

export const COMMAND_NAME = "抽獎";

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 } as const;
const ResponseType = { PONG: 1, CHANNEL_MESSAGE: 4 } as const;
const EPHEMERAL = 1 << 6;
const BRAND_RED = 0xff4757;
const MAX_SIGNATURE_AGE_SECONDS = 300;

interface Interaction {
  id: string;
  type: number;
  token: string;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  data?: { name: string; options?: { name: string; value: unknown }[] };
  member?: { user?: { id: string } };
  user?: { id: string };
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string | null,
  timestamp: string | null,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!signatureHex || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > MAX_SIGNATURE_AGE_SECONDS) return false;
  const key = hexToBytes(publicKeyHex);
  const sig = hexToBytes(signatureHex);
  if (!key || key.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, sig, new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

export function discordRoomId(channelId: string): string {
  return `dc-${channelId}`;
}

export function isAllowedDiscordChannel(env: Env, guildId: string | undefined, channelId: string | undefined): boolean {
  const guilds = listVar(env.DISCORD_ALLOWED_GUILDS);
  const channels = listVar(env.DISCORD_ALLOWED_CHANNELS);
  return !!guildId && !!channelId && guilds.includes(guildId) && channels.includes(channelId);
}

function ephemeral(content: string): Response {
  return json({ type: ResponseType.CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
}

/** GIFs recorded from the page's own animation (assets/ on GitHub Pages). */
function assetUrl(env: Env, name: string): string {
  return new URL(`assets/${name}?v=5`, env.PAGES_URL).toString();
}

function rollingEmbed(env: Env, min: number, max: number, count: number) {
  return {
    title: "🎰 幸運抽獎輪盤轉動中…",
    color: BRAND_RED,
    image: { url: assetUrl(env, "discord-roll.gif") },
    footer: { text: `範圍 ${min}–${max}・抽取 ${count} 個` },
  };
}

function reelSpinEmbed(min: number, max: number, count: number, reels: string, title = "🎰 幸運抽獎輪盤轉動中…", color = BRAND_RED) {
  return {
    title,
    color,
    description: reels,
    footer: { text: `範圍 ${min}–${max}・抽取 ${count} 個` },
  };
}

function resultImageUrl(requestUrl: string, roomId: string, sequence: number): string {
  return new URL(`/img/result/${roomId}/${sequence}.png`, requestUrl).toString();
}

function watchUrl(env: Env, roomId: string, sequence?: number): string {
  const url = new URL(env.PAGES_URL);
  url.searchParams.set("room", roomId);
  if (sequence !== undefined) url.searchParams.set("draw", String(sequence));
  return url.toString();
}

function resultMessage(env: Env, committed: DrawCommitted, userId: string | undefined, origin: string) {
  const { draw } = committed;
  const sorted = [...draw.results].sort((a, b) => a - b);
  const reels = reelsAvailable();
  const digits = reelDigits(draw.max);
  const shown = reels ? reelRows(sorted, digits) : [];
  return {
    content: "",
    embeds: [
      {
        title: "🎉 恭喜中獎！",
        color: BRAND_RED,
        description: `${reels ? `${reelContent(shown, digits, digits)}
` : ""}中獎號碼：**${sorted.join("、")}**`,
        fields: [
          { name: "範圍", value: `${draw.min}–${draw.max}`, inline: true },
          { name: "數量", value: String(draw.count), inline: true },
          { name: "第幾抽", value: `#${draw.sequence}`, inline: true },
          ...(userId ? [{ name: "抽獎者", value: `<@${userId}>`, inline: true }] : []),
        ],
        ...(reels ? {} : { image: { url: resultImageUrl(origin, committed.roomId, draw.sequence) } }),
        thumbnail: { url: assetUrl(env, "discord-win.gif") },
        footer: {
          text:
            shown.length < sorted.length
              ? `轉盤顯示前 ${shown.length} 個・號碼由小到大・由伺服器產生並保存`
              : "號碼由小到大顯示・由伺服器產生並保存",
        },
        timestamp: draw.createdAt,
      },
    ],
    components: [
      {
        type: 1,
        components: [{ type: 2, style: 5, label: "在網頁看動畫", url: watchUrl(env, committed.roomId, draw.sequence) }],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// discord-roll.gif = 3s READY hold (absorbs Discord's GIF load delay) + the page's exact 4.24s roll,
// plus a buffer so slower clients still see the whole roll before the result appears.
const ROLL_MS = 3000 + 4240 + 800;

// Slot reels: all spin, then columns stop left to right like a slot machine.
const REEL_SPIN_MS = 3500;
const REEL_STOP_GAP_MS = 1200;
// After the last reel stops: hold the stopped reels, a short "開獎" beat, then the result card.
const REEL_HOLD_MS = 1500;
const REEL_REVEAL_MS = 800;
const GOLD = 0xffc542;

/** Stops the reels column by column, the last edit also reveals the result embed. */
async function animateReels(env: Env, interaction: Interaction, committed: DrawCommitted, origin: string): Promise<void> {
  const base = env.DISCORD_API_BASE || "https://discord.com/api/v10";
  const url = `${base}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  const patch = (body: unknown) =>
    fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const sorted = [...committed.draw.results].sort((a, b) => a - b);
  const digits = reelDigits(committed.draw.max);
  const rows = reelRows(sorted, digits);
  const steps = stopSteps(digits);
  const { min, max, count } = committed.draw;
  const send = async (body: unknown, mustDeliver = false) => {
    try {
      const res = await patch(body);
      if (!res.ok) throw new Error(`edit ${res.status}`);
    } catch (e) {
      // The draw is already committed; a failed edit must never trigger a redraw.
      console.error("discord edit failed", e instanceof Error ? e.message : "unknown");
      if (mustDeliver) {
        await sleep(1000);
        await patch(body).catch(() => undefined);
      }
    }
  };
  const spinning = (stopped: number, title?: string, color?: number) => ({
    embeds: [reelSpinEmbed(min, max, count, reelContent(rows, digits, stopped), title, color)],
  });

  await sleep(REEL_SPIN_MS);
  for (const [i, stopped] of steps.entries()) {
    const last = i === steps.length - 1;
    await send(last ? spinning(stopped, "🎯 輪盤停止！") : spinning(stopped));
    await sleep(last ? REEL_HOLD_MS : REEL_STOP_GAP_MS);
  }
  await send(spinning(digits, "✨ 開獎！", GOLD));
  await sleep(REEL_REVEAL_MS);
  await send(resultMessage(env, committed, userId, origin), true);
}

/** Shows the page's rolling GIF, then edits the original response once to reveal the committed result. */
async function animate(env: Env, interaction: Interaction, committed: DrawCommitted, origin: string): Promise<void> {
  if (reelsAvailable()) return animateReels(env, interaction, committed, origin);
  const base = env.DISCORD_API_BASE || "https://discord.com/api/v10";
  const url = `${base}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  const body = JSON.stringify(resultMessage(env, committed, userId, origin));
  const edit = () => fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body });
  await sleep(ROLL_MS);
  try {
    const res = await edit();
    if (!res.ok) throw new Error(`edit ${res.status}`);
  } catch (e) {
    // The draw is already committed; a failed edit must never trigger a redraw.
    console.error("discord edit failed", e instanceof Error ? e.message : "unknown");
    await sleep(1000);
    await edit().catch(() => undefined);
  }
}

const ERROR_TEXT: Record<string, string> = {
  COOLDOWN: "抽獎太頻繁，請稍候幾秒再試。",
  DAILY_LIMIT: "今日抽獎次數已達上限（UTC 00:00 重置）。",
};

export async function handleDiscordInteraction(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.DISCORD_PUBLIC_KEY) throw new HttpError(503, "DISCORD_NOT_CONFIGURED", "Discord 尚未設定。");
  const body = await request.text();
  if (body.length > 64 * 1024) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "請求內容過大。");
  const ok = await verifyDiscordSignature(
    env.DISCORD_PUBLIC_KEY,
    request.headers.get("X-Signature-Ed25519"),
    request.headers.get("X-Signature-Timestamp"),
    body,
  );
  if (!ok) return new Response("invalid request signature", { status: 401 });

  const interaction = JSON.parse(body) as Interaction;
  if (interaction.type === InteractionType.PING) return json({ type: ResponseType.PONG });
  if (interaction.type !== InteractionType.APPLICATION_COMMAND || interaction.data?.name !== COMMAND_NAME) {
    return ephemeral("不支援的指令。");
  }
  if (!isAllowedDiscordChannel(env, interaction.guild_id, interaction.channel_id)) {
    return ephemeral("此頻道沒有開放 /抽獎。");
  }

  const opts = new Map((interaction.data.options ?? []).map((o) => [o.name, o.value]));
  const roomId = discordRoomId(interaction.channel_id!);
  const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  const res = await stub.fetch("https://room/discord-draw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      roomId,
      requestId: `discord:${interaction.id}`,
      min: opts.get("最小") ?? DEFAULT_SETTINGS.min,
      max: opts.get("最大") ?? DEFAULT_SETTINGS.max,
      count: opts.get("數量") ?? DEFAULT_SETTINGS.count,
    }),
  });
  const payload = (await res.json()) as DrawCommitted & { error?: { code: string; message: string } };
  if (!res.ok || payload.error) {
    const code = payload.error?.code ?? "";
    return ephemeral(`❌ ${ERROR_TEXT[code] ?? payload.error?.message ?? "抽獎失敗，請稍後再試。"}`);
  }

  // A replayed interaction (Discord retry) already has its message; just answer with the result.
  const origin = new URL(request.url).origin;
  if (payload.replayed) return json({ type: ResponseType.CHANNEL_MESSAGE, data: resultMessage(env, payload, undefined, origin) });

  ctx.waitUntil(animate(env, interaction, payload, origin));
  const { min, max, count } = payload.draw;
  const reels = reelsAvailable();
  const digits = reelDigits(max);
  const rows = reelRows([...payload.draw.results].sort((a, b) => a - b), digits);
  return json({
    type: ResponseType.CHANNEL_MESSAGE,
    data: {
      embeds: [reels ? reelSpinEmbed(min, max, count, reelContent(rows, digits, 0)) : rollingEmbed(env, min, max, count)],
      components: [{ type: 1, components: [{ type: 2, style: 5, label: "網頁同步觀看", url: watchUrl(env, roomId) }] }],
      allowed_mentions: { parse: [] },
    },
  });
}

