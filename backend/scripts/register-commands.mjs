// Registers the /抽獎 guild command. Guild commands update instantly.
// Usage (PowerShell):
//   $env:DISCORD_APPLICATION_ID="..."; $env:DISCORD_BOT_TOKEN="..."; npm run register-commands
// The bot token is read from the environment only; never commit it.

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID ?? "1364050807544090695";

if (!appId || !token) {
  console.error("請設定環境變數 DISCORD_APPLICATION_ID 與 DISCORD_BOT_TOKEN。");
  process.exit(1);
}

const commands = [
  {
    name: "抽獎",
    type: 1,
    description: "啟動 Artale 幸運抽獎輪盤（號碼不重複）",
    contexts: [0], // guild only
    options: [
      { type: 4, name: "最小", description: "範圍(小)，預設 1", min_value: 0, max_value: 999999 },
      { type: 4, name: "最大", description: "範圍(大)，預設 50", min_value: 1, max_value: 1000000 },
      { type: 4, name: "數量", description: "抽取數量，預設 1", min_value: 1, max_value: 100 },
    ],
  },
];

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`, {
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
