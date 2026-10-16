<#
.SYNOPSIS
  Windows entry point: finds the WSL distro that hosts the OpenClaw gateway, pushes this repo into it and
  applies it. Safe to re-run; run again after any OpenClaw / LLM-server reinstall.
  (On Linux/macOS, run packs/openclaw/scripts/apply.sh directly.) Needs Node.js on Windows only to build dist/ once.
.PARAMETER Distro   WSL distro name. Auto-detected when omitted.
.PARAMETER DryRun   Validate only, change nothing.
.PARAMETER Mode     LLM selection: auto (default) | keep | follow | manual. See packs/openclaw/config/overrides.env.example.
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

. "$repo\packs\openclaw\scripts\wsl-distros.ps1"

if (-not $Distro) {
  $Distro = Find-OpenClawDistro
}
Write-Host "Using WSL distro: $Distro"

$pack = 'packs/openclaw'
if (-not (Test-Path "$repo\dist\agent-spaghetti-env.mjs")) {
  Write-Host 'Building the env bundle (dist/agent-spaghetti-env.mjs) ...'
  Push-Location $repo; try { npm run -s build; if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' } } finally { Pop-Location }
}

Write-Host 'Pushing repo ...'
# Stream a tar so we do not depend on /mnt drive mounts (not all distros mount them). Only what apply.sh needs.
$remote = 'rm -rf ~/.openclaw-orchestrator-src ~/.agent-spaghetti-src && mkdir -p ~/.agent-spaghetti-src && tar -xf - -C ~/.agent-spaghetti-src && find ~/.agent-spaghetti-src -type f \( -name "*.sh" -o -name jobctl -o -name pack-shim \) -exec sed -i "s/\r$//" {} + && chmod +x ~/.agent-spaghetti-src/packs/openclaw/scripts/*'
& tar.exe -cf - -C $repo --exclude=overrides.env dist/agent-spaghetti-env.mjs packages/core/src/env/find-node.sh $pack | wsl.exe -d $Distro -- bash -c $remote
if ($LASTEXITCODE -ne 0) { throw 'Failed to copy repo into WSL.' }
if (Test-Path "$repo\$pack\config\overrides.env") {
  Get-Content "$repo\$pack\config\overrides.env" -Raw | wsl.exe -d $Distro -- bash -c "cat > ~/.agent-spaghetti-src/$pack/config/overrides.env"
}

$envPrefix = if ($Mode) { "PROVIDER_MODE=$Mode " } else { '' }
$flag = if ($DryRun) { '--dry-run' } else { '' }
wsl.exe -d $Distro -- bash -lc "${envPrefix}~/.agent-spaghetti-src/$pack/scripts/apply.sh $flag"
if ($LASTEXITCODE -ne 0) { throw "apply.sh failed (exit $LASTEXITCODE)." }
if (-not $DryRun) { & "$repo\healthcheck.ps1" -Distro $Distro }
