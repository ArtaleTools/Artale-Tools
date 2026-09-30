# 註冊 Discord /抽獎 指令。Bot Token 以隱藏輸入取得，只存在這個 PowerShell 程序中。
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..
$secure = Read-Host "請貼上 Bot Token（輸入不會顯示）" -AsSecureString
$env:DISCORD_BOT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
$env:DISCORD_APPLICATION_ID = "1554897351750058044"
try {
    node scripts/register-commands.mjs
} finally {
    Remove-Item Env:DISCORD_BOT_TOKEN -ErrorAction SilentlyContinue
}
