# close-liposts-chrome.ps1 — kill ONLY the liposts Chrome (by recorded PID),
# never by process name: other lanes run their own chromes.
$pidFile = Join-Path $PSScriptRoot 'liposts-chrome.pid'
if (-not (Test-Path $pidFile)) { Write-Output "no pid file"; exit 0 }
$thePid = Get-Content $pidFile -ErrorAction SilentlyContinue
if ($thePid -and (Get-Process -Id $thePid -ErrorAction SilentlyContinue)) {
  # kill the process tree rooted at the recorded pid (chrome spawns children)
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$thePid" -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $thePid -Force -ErrorAction SilentlyContinue
  Write-Output "killed pid $thePid"
} else {
  Write-Output "pid $thePid not running"
}
Remove-Item $pidFile -ErrorAction SilentlyContinue
