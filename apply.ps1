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
# Only what apply.sh needs (incl. config/overrides.env if present). Written to a file and fed to wsl.exe as stdin:
# Windows PowerShell 5.1 corrupts binary data piped between native commands. No /mnt drive mounts needed.
$src = '.agent-spaghetti-src'
$tarFile = Join-Path $env:TEMP "agent-spaghetti-src-$PID.tar"
try {
  & tar.exe -cf $tarFile -C $repo dist/agent-spaghetti-env.mjs packages/core/src/env/find-node.sh $pack
  if ($LASTEXITCODE -ne 0) { throw 'tar failed.' }
  & wsl.exe -d $Distro --cd ~ --exec rm -rf $src .openclaw-orchestrator-src
  & wsl.exe -d $Distro --cd ~ --exec mkdir -p $src
  $p = Start-Process wsl.exe -ArgumentList "-d $Distro --cd ~ --exec tar -xf - -C $src" -RedirectStandardInput $tarFile -NoNewWindow -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Failed to copy the pack into WSL (tar exit $($p.ExitCode))." }
} finally { Remove-Item -ErrorAction SilentlyContinue $tarFile }

$envPrefix = if ($Mode) { "PROVIDER_MODE=$Mode " } else { '' }
$flag = if ($DryRun) { '--dry-run' } else { '' }
wsl.exe -d $Distro -- bash -lc "${envPrefix}bash ~/$src/$pack/scripts/apply.sh $flag"
if ($LASTEXITCODE -ne 0) { throw "apply.sh failed (exit $LASTEXITCODE)." }
if (-not $DryRun) { & "$repo\healthcheck.ps1" -Distro $Distro }
