param(
  [int]$ApiPort = 3001,
  [int]$WebPort = 5173,
  [string]$DataDir = "server/data"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$ip = $null
$ipconfig = ipconfig
foreach ($line in $ipconfig) {
  if ($line -match "IPv4.*:\s*([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)") {
    $candidate = $Matches[1]
    if ($candidate -ne "127.0.0.1" -and -not $candidate.StartsWith("169.254.")) {
      $ip = $candidate
      break
    }
  }
}

if (-not $ip) {
  $ip = "YOUR_PC_LAN_IP"
}

$env:HOST = "0.0.0.0"
$env:PORT = "$ApiPort"
$env:DATA_DIR = $DataDir
$env:VITE_DEV_API_TARGET = "http://127.0.0.1:$ApiPort"

Write-Host ""
Write-Host "LAN dev services will start backend and frontend."
Write-Host "PC local URL: http://localhost:$WebPort"
Write-Host "Phone web URL: http://$ip`:$WebPort"
Write-Host "Backend API URL: http://$ip`:$ApiPort"
Write-Host "Android App server URL: http://$ip`:$ApiPort"
Write-Host ""
Write-Host "Notes:"
Write-Host "1. Do not use localhost on the phone. Use the Phone web URL above."
Write-Host "2. In the Android App login page, use the Android App server URL above."
Write-Host "3. If the phone cannot access it, allow Node.js or ports $ApiPort/$WebPort through Windows Firewall."
Write-Host "4. Keep the services running while testing."
Write-Host ""

$serverCommand = "set HOST=$($env:HOST)&& set PORT=$ApiPort&& set DATA_DIR=$DataDir&& npm.cmd run server:dev"
$clientCommand = "set VITE_DEV_API_TARGET=$($env:VITE_DEV_API_TARGET)&& npm.cmd run client:dev"

Start-Process -FilePath "cmd.exe" -WindowStyle Hidden -WorkingDirectory $root -ArgumentList @("/k", $serverCommand)
Start-Process -FilePath "cmd.exe" -WindowStyle Hidden -WorkingDirectory $root -ArgumentList @("/k", $clientCommand)
