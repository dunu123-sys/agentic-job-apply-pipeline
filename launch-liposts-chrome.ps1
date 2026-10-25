# launch-liposts-chrome.ps1 — ISOLATED Chrome for the liposts source.
#   - Own CDP port 9225 (never collides with the apply runners on 9223/9224)
#   - Own profile: li-profile-posts (clone of li-profile; cookies copied)
#   - --disable-gpu: this host's GPU is usually at full LLM stress; GPU-starved
#     compositing wedged the page during wheel-event tests (operator theory
#     2026-10-25). Software rendering is slower but stable.
#   - NO initial URL (lesson: open welcome page, navigate via CDP; /json/new
#     kills Chrome - never use it).
#   - PID is saved so close-liposts-chrome.ps1 kills ONLY this instance -
#     other lanes' chromes are never touched.
param([int]$Port = 9225)

$chrome = if ($env:CHROME_PATH) { $env:CHROME_PATH } else { 'chrome.exe' }
$profile = Join-Path $PSScriptRoot 'profiles\li-profile-posts'
$pidFile = Join-Path $PSScriptRoot 'liposts-chrome.pid'

if (Test-Path $pidFile) {
  $old = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
    Write-Output "already running (pid $old)"; exit 0
  }
}

$p = Start-Process -FilePath $chrome -ArgumentList @(
  "--user-data-dir=$profile",
  "--remote-debugging-port=$Port",
  "--disable-gpu",
  "--disable-gpu-compositing",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1280,900"
) -PassThru
Set-Content -Path $pidFile -Value $p.Id
Start-Sleep -Seconds 4
Write-Output "launched pid $($p.Id) on port $Port"
