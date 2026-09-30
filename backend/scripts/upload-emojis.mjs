// Uploads the slot-reel emojis in backend/emoji/ as Discord *application emojis* (usable by the app
// anywhere, no server install needed) and writes their public IDs to src/emojis.json.
// Usage: run scripts/upload-emojis.ps1 (asks for the bot token without echoing it).
// Existing emojis with the same name are reused; pass --replace to re-upload them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
if (!appId || !token) {
  console.error("請設定環境變數 DISCORD_APPLICATION_ID 與 DISCORD_BOT_TOKEN。");
  process.exit(1);
}
const replace = process.argv.includes("--replace");
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const api = `https://discord.com/api/v10/applications/${appId}/emojis`;
const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };

async function call(url, init = {}) {
  for (;;) {
    const res = await fetch(url, { ...init, headers });
    if (res.status === 429) {
      const body = await res.json();
      await new Promise((r) => setTimeout(r, (body.retry_after ?? 1) * 1000 + 100));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  }
}

const existing = new Map((await call(api)).items.map((e) => [e.name, e]));
const out = {};
for (const file of fs.readdirSync(path.join(root, "emoji")).sort()) {
  const name = path.parse(file).name; // lt_0 … lt_9, lt_spin1 … lt_spin3
  const mime = file.endsWith(".gif") ? "image/gif" : "image/png";
  let emoji = existing.get(name);
  if (emoji && replace) {
    await call(`${api}/${emoji.id}`, { method: "DELETE" });
    emoji = undefined;
  }
  if (!emoji) {
    const image = `data:${mime};base64,${fs.readFileSync(path.join(root, "emoji", file)).toString("base64")}`;
    emoji = await call(api, { method: "POST", body: JSON.stringify({ name, image }) });
    console.log(`上傳 ${name}`);
  } else {
    console.log(`沿用 ${name}`);
  }
  out[name] = { id: emoji.id, animated: !!emoji.animated };
}
fs.writeFileSync(path.join(root, "src", "emojis.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`完成，共 ${Object.keys(out).length} 個表情，已寫入 src/emojis.json`);
