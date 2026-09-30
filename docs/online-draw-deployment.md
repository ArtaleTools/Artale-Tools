# 線上抽獎 + Discord `/抽獎` 部署說明

架構：GitHub Pages（`index.html` + `config.js`）＋ Cloudflare Worker `artale-draw`（`backend/`，SQLite Durable Objects + WebSocket Hibernation）。Discord 使用 HTTP Interactions Endpoint，不需要常駐 bot 程序。全部在免費方案內運作。

需求：Node.js 20 以上。

## 1. 本機開發與測試

```powershell
cd backend
npm ci
npm test          # 單元測試：亂數、驗證、Discord 簽章
npm run smoke     # 端對端：啟動 wrangler dev，測房主／觀眾／Discord 流程
npm run typecheck
```

## 2. 建立 Discord 應用程式（你本人操作）

1. 到 https://discord.com/developers/applications → **New Application**，取名例如「Artale 抽獎」。
2. **General Information** 頁：複製 **Application ID** 與 **Public Key**（兩者都是公開值）。
3. **Bot** 頁：按 **Reset Token** 取得 Bot Token（秘密，只在第 5 步本機使用，不要貼到任何地方）。
4. **Installation** 頁：Install Link 選 Discord Provided Link，Guild Install 的 scopes 勾 `applications.commands`（不需要 `bot` scope 也能用斜線指令）。用這個連結把應用程式加入伺服器 `1364050807544090695`。

## 3. 部署 Worker

1. 把 `backend/wrangler.jsonc` 的 `DISCORD_APPLICATION_ID`、`DISCORD_PUBLIC_KEY` 填入第 2 步的值。
2. 登入並部署：

```powershell
cd backend
npx wrangler login
npx wrangler deploy
```

部署完成會顯示網址，例如 `https://artale-draw.<子網域>.workers.dev`。

3. （可選，網頁「建立線上房間」才需要）Cloudflare 後台 → Turnstile → 新增 widget，網域填 `artaletools.github.io`，取得 Site Key 與 Secret Key：

```powershell
npx wrangler secret put TURNSTILE_SECRET
```

沒有設定 Turnstile 時，網頁建立房間會回 503（fail closed）；**Discord `/抽獎` 不需要 Turnstile**，照樣可用。

## 4. 設定 Discord Interactions Endpoint

Developer Portal → **General Information** → **Interactions Endpoint URL** 填：

```
https://artale-draw.<子網域>.workers.dev/discord/interactions
```

按 Save。Discord 會送驗證請求（含一次錯誤簽章），Worker 正確回應才能存檔。

## 5. 註冊 `/抽獎` 指令

```powershell
cd backend
$env:DISCORD_APPLICATION_ID="你的 Application ID"
$env:DISCORD_BOT_TOKEN="你的 Bot Token"
npm run register-commands
Remove-Item Env:DISCORD_BOT_TOKEN
```

指令為全域註冊，支援「使用者安裝」（裝在你的帳號，不需要伺服器管理權限）與「伺服器安裝」；Worker 仍只允許指定的伺服器與頻道使用。使用者安裝連結：`https://discord.com/oauth2/authorize?client_id=1554897351750058044&scope=applications.commands&integration_type=1`。指令選項：`最小`（預設 1）、`最大`（預設 50）、`數量`（預設 1）。

## 6. 設定前端並發布

編輯 repo 根目錄 `config.js`：

```js
window.ARTALE_CONFIG = {
    API_BASE_URL: "https://artale-draw.<子網域>.workers.dev",
    TURNSTILE_SITE_KEY: "<Turnstile Site Key，沒有就留空>"
};
```

合併到 `main` 後 GitHub Pages 自動更新。

## 7. 使用方式

- Discord 頻道 `1364050809549225989` 輸入 `/抽獎`（可帶 最小／最大／數量）。Bot 訊息會跳號約 4 秒後停在結果，並附「在網頁看動畫」按鈕。
- 頻道對應的網頁房間：`https://artaletools.github.io/Artale-Tools/?room=dc-1364050809549225989`。開著這頁的人會在有人打 `/抽獎` 時同步播放原本的跳號、震動、彩帶動畫（音效需先點一下頁面或「啟用音效」）。
- 加上 `&draw=<第幾抽>` 可重播該次動畫。
- 網頁「線上房間」→「建立線上房間」：自己當房主，分享連結讓大家同步觀看（需 Turnstile）。

## 8. 限制與成本

- 每房間：抽獎間隔 ≥ 2 秒、每 UTC 日 500 次、最多 100 條 WebSocket、網頁房間 24 小時到期（關閉後保留紀錄 7 天）、Discord 房間永久但只保留最近 100 筆。
- `ratelimits`（建立房間每 IP 每分鐘 5 次、WebSocket 連線每 IP 每分鐘 30 次）是各據點近似計數，不是精確全域限制。
- Workers Free：每日 100,000 requests；Durable Objects Free：每日 100,000 requests、13,000 GB-s。超額時相應請求失敗，不會自動收費。升級 Paid 前請重新估算。
- Discord 訊息中的跳號是編輯同一則訊息 6 次，Discord 端無法跑網頁 JS 動畫；完整動畫在網頁房間。

## 9. 回滾

`npx wrangler rollback` 回到前一版。不要刪除 `ROOMS` Durable Object namespace 或移除 `v1` migration，否則房間資料會遺失。
