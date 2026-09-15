# Measures the SapVault UI at several window sizes.
#
# It serves `ui/` with a fixture IPC bridge (tools/serve-ui.mjs) and drives Edge
# - the same engine WebView2 uses - over the DevTools protocol, so the real
# rendered geometry can be inspected and iterated on without rebuilding the app.
#
#   pwsh tools/audit-ui.ps1
#   pwsh tools/audit-ui.ps1 -Sizes 1000x660,1240x800
#   pwsh tools/audit-ui.ps1 -KeepOpen

param(
  [string[]]$Sizes = @("1240x800", "1600x900", "1920x1080"),
  [switch]$KeepOpen,
  [switch]$WithModals,
  [string]$ShotView = "",
  [int]$Port = 9222,
  [int]$UiPort = 5173
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path -LiteralPath $edge)) { throw "Edge not found at $edge" }

$profile = Join-Path $env:TEMP "sapvault-edge-audit"
if (Test-Path -LiteralPath $profile) { Remove-Item -LiteralPath $profile -Recurse -Force }

$env:SAPVAULT_CDP_PORT = "$Port"
$env:SAPVAULT_UI_PORT = "$UiPort"

$server = Start-Process -FilePath "node" -ArgumentList "tools\serve-ui.mjs" -WorkingDirectory $repo -PassThru -WindowStyle Hidden
$browser = $null

try {
  $uiReady = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    try {
      $null = Invoke-WebRequest -Uri "http://127.0.0.1:$UiPort/" -TimeoutSec 2 -UseBasicParsing
      $uiReady = $true
      break
    } catch { }
  }
  if (-not $uiReady) { throw "static server did not start on port $UiPort" }

  $browser = Start-Process -FilePath $edge -PassThru -WindowStyle Hidden -ArgumentList @(
    "--headless=new",
    "--remote-debugging-port=$Port",
    "--user-data-dir=$profile",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--force-device-scale-factor=1",
    "--window-size=1240,800",
    "http://127.0.0.1:$UiPort/"
  )

  $cdpReady = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 400
    try {
      $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 2
      $cdpReady = $true
      break
    } catch { }
  }
  if (-not $cdpReady) { throw "DevTools endpoint did not come up on port $Port" }

  Push-Location $repo
  if ($WithModals) {
    node tools\inspect-ui.mjs audit
  } else {
    node tools\inspect-ui.mjs sizes ($Sizes -join ",")
  }

  if ($ShotView) {
    $shot = Join-Path $env:TEMP "sapvault-$($ShotView).png"
    if ($ShotView -eq "编辑") {
      node tools\inspect-ui.mjs modal | Out-Null
    } else {
      node tools\inspect-ui.mjs click $ShotView | Out-Null
    }
    Start-Sleep -Milliseconds 600
    node tools\inspect-ui.mjs shot $shot | Out-Null
    & (Join-Path $PSScriptRoot "ascii-shot.ps1") -Path $shot -Cols 100 -Rows 30
  }
} finally {
  if ($browser -and -not $browser.HasExited) { $browser.Kill() }
  if ($server -and -not $server.HasExited) { $server.Kill() }
  Start-Sleep -Milliseconds 400
  if (-not $KeepOpen) {
    Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue
  }
  Pop-Location -ErrorAction SilentlyContinue
}
