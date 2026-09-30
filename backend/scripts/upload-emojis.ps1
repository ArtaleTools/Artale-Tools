# 上傳轉盤表情符號（Discord 應用程式表情）。Bot Token 以隱藏輸入取得，只存在這個 PowerShell 程序中。
$ErrorActionPreference = "Stop"
foreach ($a in $args) {
    if ($a -match '[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}') {
        Write-Host "偵測到指令後面貼了 Bot Token！請不要把 Token 放在指令裡，並立刻到 Developer Portal 重設 Token。" -ForegroundColor Red
        exit 1
    }
}
Set-Location $PSScriptRoot\..
Write-Host "先按 Enter 執行指令，看到提示後再貼上 Token。" -ForegroundColor Yellow
$secure = Read-Host "請貼上 Bot Token（輸入不會顯示）" -AsSecureString
$env:DISCORD_BOT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
$env:DISCORD_APPLICATION_ID = "1554897351750058044"
try {
    node scripts/upload-emojis.mjs @args
} finally {
    Remove-Item Env:DISCORD_BOT_TOKEN -ErrorAction SilentlyContinue
}
