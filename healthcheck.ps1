param([string]$Distro)
# In-distro wiring report (works with any LLM provider). Exit code = number of problems.
. "$PSScriptRoot\packs\openclaw\scripts\wsl-distros.ps1"
if (-not $Distro) { $Distro = Find-OpenClawDistro }
wsl.exe -d $Distro -- bash -lc '~/.local/bin/agent-spaghetti-healthcheck'
exit $LASTEXITCODE
