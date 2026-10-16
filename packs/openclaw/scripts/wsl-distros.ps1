# Shared by apply.ps1 and healthcheck.ps1. Only distros that are already running are looked at (a stopped distro is
# never started); docker-desktop* is skipped. --exec avoids wsl.exe re-parsing the command through a shell.
function Get-RunningDistros { (wsl.exe -l --running -q) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notmatch '^docker-desktop' } }
function Test-OpenClaw([string]$d) {
  $ErrorActionPreference = 'Continue'
  wsl.exe -d $d --exec sh -c 'command -v openclaw >/dev/null 2>&1 || [ -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/openclaw.json" ]' 2>$null | Out-Null
  $LASTEXITCODE -eq 0
}
function Find-OpenClawDistro {
  $running = @(Get-RunningDistros)
  $found = @($running | Where-Object { Test-OpenClaw $_ })
  if ($found.Count -eq 0) { throw "No running WSL distro with OpenClaw found (running: $($running -join ', ')). Start it or pass -Distro." }
  if ($found.Count -gt 1) { throw "Several distros have OpenClaw ($($found -join ', ')). Pass -Distro." }
  $found[0]
}
