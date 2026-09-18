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
  [switch]$Interactions,
  [string]$ShotView = "",
  # 0 = pick a free port, so an already running browser (or another tool) cannot
  # collide with the audit.
  [int]$Port = 0,
  [int]$UiPort = 0
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path -LiteralPath $edge)) { throw "Edge not found at $edge" }

# Edge spawns its renderer/GPU children inside the same --user-data-dir. Killing
# only the process we started leaves those behind: they keep eating memory and
# hold locks on the temp profile, so the cleanup below silently fails and every
# run piles up another set. Kill the whole profile's process tree instead.
function Stop-ProfileBrowsers {
  param([string]$ProfilePath)
  for ($round = 0; $round -lt 4; $round++) {
    $stray = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains($ProfilePath) })
    if ($stray.Count -eq 0) { return $true }
    foreach ($item in $stray) {
      Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 350
  }
  return $false
}

# Binds a throwaway listener to ask Windows for a free port.
function Get-FreePort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  return $port
}

if ($Port -le 0) { $Port = Get-FreePort }
if ($UiPort -le 0) { $UiPort = Get-FreePort }

$profile = Join-Path $env:TEMP "sapvault-edge-audit"
if (Test-Path -LiteralPath $profile) {
  $null = Stop-ProfileBrowsers -ProfilePath $profile
  Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue
}

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

  if ($Interactions) {
    # Runs against the same page, so it needs no second terminal.
    node tools\check-interactions.mjs
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
  if ($browser -and -not $browser.HasExited) {
    # /T kills the renderer and GPU children too, which is what actually holds
    # the temp profile open (a plain Kill() leaves them behind).
    & taskkill /PID $browser.Id /T /F 2>$null | Out-Null
  }
  if ($server -and -not $server.HasExited) { $server.Kill() }
  $null = Stop-ProfileBrowsers -ProfilePath $profile
  if (-not $KeepOpen) {
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
      try {
        Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction Stop
        break
      } catch {
        Start-Sleep -Milliseconds 300
      }
    }
    if (Test-Path -LiteralPath $profile) {
      Write-Warning "临时 profile 未能删除（可能有残留 Edge 进程）：$profile"
    }
  }
  Pop-Location -ErrorAction SilentlyContinue
}
