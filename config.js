// 公開設定（不是秘密）。部署 Worker 後，把 API_BASE_URL 換成實際的 workers.dev 網址，例如
//   https://artale-draw.<你的子網域>.workers.dev
// 留空時線上房間會顯示「線上功能尚未設定」，本機抽獎不受影響。
window.ARTALE_CONFIG = {
    API_BASE_URL: "https://artale-draw.artale-draw.workers.dev",
    TURNSTILE_SITE_KEY: "0x4AAAAAAFKX1u4zZyrl6RK0"
};
