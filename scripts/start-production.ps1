param(
  [int]$Port = 3001,
  [string]$DataDir = "server/data",
  [string]$PublicBaseUrl = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

if (-not (Test-Path "dist/index.html")) {
  Write-Host "未发现 dist/index.html，请先执行 npm.cmd run build。"
  exit 1
}

$env:HOST = "0.0.0.0"
$env:PORT = "$Port"
$env:DATA_DIR = $DataDir
if ($PublicBaseUrl) {
  $env:PUBLIC_BASE_URL = $PublicBaseUrl.TrimEnd("/")
  $env:ALLOWED_ORIGINS = "$($env:PUBLIC_BASE_URL),capacitor://localhost,http://localhost"
}

Write-Host ""
Write-Host "生产服务即将启动"
Write-Host "本机访问: http://localhost:$Port"
if ($env:PUBLIC_BASE_URL) {
  Write-Host "公网访问: $($env:PUBLIC_BASE_URL)"
  Write-Host "Android App 服务器地址: $($env:PUBLIC_BASE_URL)"
} else {
  Write-Host "未配置公网地址。可使用 -PublicBaseUrl https://your-domain.example.com"
}
Write-Host "数据目录: $DataDir"
Write-Host ""

npm.cmd run start
