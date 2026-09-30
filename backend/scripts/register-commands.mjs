// Registers /抽獎 as a GLOBAL command that supports user install (no server admin needed)
// and guild install. Usage is still restricted by the Worker to the allowed guild/channel.
// Usage (PowerShell):
//   $env:DISCORD_APPLICATION_ID="..."; $env:DISCORD_BOT_TOKEN="..."; npm run register-commands
// The bot token is read from the environment only; never commit it.

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;

if (!appId || !token) {
  console.error("請設定環境變數 DISCORD_APPLICATION_ID 與 DISCORD_BOT_TOKEN。");
  process.exit(1);
}

const commands = [
  {
    name: "抽獎",
    type: 1,
    description: "啟動 Artale 幸運抽獎輪盤（號碼不重複）",
    integration_types: [0, 1], // 0 = guild install, 1 = user install
    contexts: [0], // usable in servers only
    options: [
      { type: 4, name: "最小", description: "範圍(小)，預設 1", min_value: 0, max_value: 999999 },
      { type: 4, name: "最大", description: "範圍(大)，預設 50", min_value: 1, max_value: 1000000 },
      { type: 4, name: "數量", description: "抽取數量，預設 1", min_value: 1, max_value: 100 },
    ],
  },
];

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});
const text = await res.text();
if (!res.ok) {
  console.error(`註冊失敗 HTTP ${res.status}: ${text}`);
  process.exit(1);
}
console.log("已註冊指令：", JSON.parse(text).map((c) => `/${c.name}`).join(", "));
