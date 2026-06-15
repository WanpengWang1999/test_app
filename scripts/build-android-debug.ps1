param(
  [string]$JavaHome = "",
  [string]$SdkDir = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

if (-not $JavaHome) {
  $candidates = @(
    'C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot',
    'C:\Program Files\Microsoft\jdk-21*',
    'C:\Program Files\Eclipse Adoptium\jdk-21*',
    'C:\Program Files\Java\jdk-21*'
  )
  foreach ($candidate in $candidates) {
    $found = Get-Item $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found -and (Test-Path (Join-Path $found.FullName 'bin\java.exe'))) {
      $JavaHome = $found.FullName
      break
    }
  }
}

if (-not $JavaHome -or -not (Test-Path (Join-Path $JavaHome 'bin\java.exe'))) {
  throw 'JDK 21 was not found. Install Microsoft OpenJDK 21 or pass -JavaHome.'
}

if (-not $SdkDir) {
  $localSdk = Join-Path $root '.tools\android-sdk'
  $defaultSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
  if (Test-Path $localSdk) {
    $SdkDir = $localSdk
  } elseif (Test-Path $defaultSdk) {
    $SdkDir = $defaultSdk
  }
}

if (-not $SdkDir -or -not (Test-Path $SdkDir)) {
  throw 'Android SDK was not found. Install Android SDK or pass -SdkDir.'
}

$env:JAVA_HOME = $JavaHome
$env:ANDROID_HOME = $SdkDir
$env:ANDROID_SDK_ROOT = $SdkDir
$env:Path = "$JavaHome\bin;$SdkDir\platform-tools;$env:Path"

$sdkPathForGradle = (Resolve-Path $SdkDir).Path.Replace('\', '/')
Set-Content -Path 'android\local.properties' -Value "sdk.dir=$sdkPathForGradle" -Encoding ASCII

Write-Host "JDK: $JavaHome"
Write-Host "Android SDK: $SdkDir"
Write-Host 'Building Android debug APK...'

npm.cmd run build
npx.cmd cap sync android
Push-Location android
try {
  .\gradlew.bat assembleDebug --no-daemon
} finally {
  Pop-Location
}

$apk = Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path $apk)) {
  throw "Build finished but APK was not found: $apk"
}

Write-Host "APK generated: $apk"
