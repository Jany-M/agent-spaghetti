<#
.SYNOPSIS
  Windows entry point: finds the WSL distro that hosts the OpenClaw gateway, pushes this repo into it and
  applies it. Safe to re-run; run again after any OpenClaw / LLM-server reinstall.
  (On Linux/macOS, run scripts/apply.sh directly.)
.PARAMETER Distro   WSL distro name. Auto-detected when omitted.
.PARAMETER DryRun   Validate only, change nothing.
.PARAMETER Mode     LLM selection: auto (default) | keep | follow | manual. See config/overrides.env.example.
.EXAMPLE
  .\apply.ps1
  .\apply.ps1 -DryRun
  .\apply.ps1 -Mode follow     # switch to whatever model the local server has loaded right now
#>
param(
  [string]$Distro,
  [switch]$DryRun,
  [ValidateSet('auto', 'keep', 'follow', 'manual')][string]$Mode
)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot

function Get-Distros { (wsl.exe -l -q) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ } }

if (-not $Distro) {
  $found = @(Get-Distros | Where-Object {
      wsl.exe -d $_ -- bash -lc 'command -v openclaw >/dev/null 2>&1 || ls -d ~/.openclaw/openclaw.json >/dev/null 2>&1' 2>$null
      $LASTEXITCODE -eq 0
    })
  if ($found.Count -eq 0) { throw "No WSL distro with OpenClaw found. Installed distros: $((Get-Distros) -join ', '). Pass -Distro." }
  if ($found.Count -gt 1) { throw "Several distros have OpenClaw ($($found -join ', ')). Pass -Distro." }
  $Distro = $found[0]
}
Write-Host "Using WSL distro: $Distro"

Write-Host 'Pushing repo ...'
# Stream a tar so we do not depend on /mnt drive mounts (not all distros mount them).
$remote = 'rm -rf ~/.openclaw-orchestrator-src ~/.agent-spaghetti-src && mkdir -p ~/.agent-spaghetti-src && tar -xf - -C ~/.agent-spaghetti-src && find ~/.agent-spaghetti-src -type f \( -name "*.sh" -o -name jobctl -o -name ocmcp -o -name "*.py" \) -exec sed -i "s/\r$//" {} + && chmod +x ~/.agent-spaghetti-src/scripts/*'
& tar.exe -cf - -C $repo --exclude=.git --exclude=overrides.env config mcp roles scripts | wsl.exe -d $Distro -- bash -c $remote
if ($LASTEXITCODE -ne 0) { throw 'Failed to copy repo into WSL.' }
if (Test-Path "$repo\config\overrides.env") {
  Get-Content "$repo\config\overrides.env" -Raw | wsl.exe -d $Distro -- bash -c 'cat > ~/.agent-spaghetti-src/config/overrides.env'
}

$envPrefix = if ($Mode) { "PROVIDER_MODE=$Mode " } else { '' }
$flag = if ($DryRun) { '--dry-run' } else { '' }
wsl.exe -d $Distro -- bash -lc "${envPrefix}~/.agent-spaghetti-src/scripts/apply.sh $flag"
if ($LASTEXITCODE -ne 0) { throw "apply.sh failed (exit $LASTEXITCODE)." }
if (-not $DryRun) { & "$repo\healthcheck.ps1" -Distro $Distro }
