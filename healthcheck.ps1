param([string]$Distro)
# In-distro wiring report (works with any LLM provider).
if (-not $Distro) {
  $Distro = ((wsl.exe -l -q) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Where-Object {
      wsl.exe -d $_ -- bash -lc 'ls ~/.local/bin/agent-spaghetti-healthcheck >/dev/null 2>&1'; $LASTEXITCODE -eq 0 } | Select-Object -First 1)
  if (-not $Distro) { throw 'agent-spaghetti-healthcheck not found in any distro. Run apply.ps1 first.' }
}
wsl.exe -d $Distro -- bash -lc '~/.local/bin/agent-spaghetti-healthcheck'
exit $LASTEXITCODE
