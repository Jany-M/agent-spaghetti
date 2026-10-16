#!/usr/bin/env bash
# Idempotent. Run on the machine/distro that hosts the OpenClaw gateway (apply.ps1 does that for Windows+WSL).
#   apply.sh [--dry-run]
# Everything machine-specific (OpenClaw binary, state dir, default agent, local LLM) is found at run time by the
# agent-spaghetti env bundle (the same engine the app uses); nothing is hard-coded. Needs Node >= 20 (OpenClaw ships one).
set -euo pipefail
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
PACK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$PACK/../.." && pwd)"
BUNDLE="$ROOT/dist/agent-spaghetti-env.mjs"
say() { printf '\n== %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# --- optional user overrides (see config/overrides.env.example)
if [ -f "$PACK/config/overrides.env" ]; then set -a; . "$PACK/config/overrides.env"; set +a; fi

[ -f "$BUNDLE" ] || die "missing $BUNDLE (build it with: npm run build)"
NODE="$(sh "$ROOT/packages/core/src/env/find-node.sh")"
[ -n "$NODE" ] || die "no Node.js >= 20 found (OpenClaw ships one; install OpenClaw first)"
pack() { "$NODE" "$BUNDLE" openclaw "$@"; }

# --- what the engine found: openclaw, config, state, agent, workspace
INFO="$(pack info)" || die "$INFO"
val() { printf '%s\n' "$INFO" | sed -n "s/^$1=//p"; }
OC="$(val openclaw)"; CFG="$(val config)"; STATE="$(val state)"; ORCH="$(val agent)"; ORCH_WS="$(val workspace)"
OD="$STATE/agent-spaghetti"
echo "openclaw: $OC"; echo "config  : $CFG"; echo "node    : $NODE"
echo "orchestrator agent: $ORCH  (workspace $ORCH_WS)"

say "1. backup"
if [ $DRY -eq 0 ]; then
  B="$STATE/agent-spaghetti-backups/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$B"
  cp -a "$CFG" "$B/"; [ -f "$ORCH_WS/AGENTS.md" ] && cp -a "$ORCH_WS/AGENTS.md" "$B/"
  chmod -R go-rwx "$STATE/agent-spaghetti-backups"; echo "backup: $B"
else echo "(dry-run: skipped)"; fi

say "2. install helper scripts"
if [ $DRY -eq 0 ]; then
  rm -rf "$OD/bin"                                                         # fresh every time: no stale helpers
  mkdir -p "$OD/bin" "$OD/mcp" "$STATE/jobs" "$HOME/.local/bin"
  install -m 755 "$PACK/scripts/jobctl" "$OD/bin/"
  install -m 644 "$BUNDLE" "$OD/bin/agent-spaghetti-env.mjs"
  printf '%s\n' "$NODE" > "$OD/bin/node.path"
  for t in ocmcp agent-spaghetti-healthcheck; do install -m 755 "$PACK/scripts/pack-shim" "$OD/bin/$t"; done
  install -m 644 "$PACK/mcp/catalog.json" "$OD/mcp/catalog.json"
  for t in jobctl ocmcp agent-spaghetti-healthcheck; do ln -sf "$OD/bin/$t" "$HOME/.local/bin/$t"; done
  echo "installed to $OD/bin (symlinked in ~/.local/bin; make sure that is on PATH)"
fi

say "3. config patch"
# 3a. static workflow settings (JSON5, validated and merged by OpenClaw)
STATIC="$(mktemp --suffix=.json5)"; trap 'rm -f "$STATIC"' EXIT
sed -e "s#{{STATE}}#$STATE#g" -e "s#{{ORCH}}#$ORCH#g" "$PACK/config/orchestrator.patch.json5" > "$STATIC"
if [ $DRY -eq 1 ]; then "$OC" config patch --file "$STATIC" --dry-run; else "$OC" config patch --file "$STATIC"; fi
# 3b. machine-specific: LLM endpoint/model/timeout (PROVIDER_MODE) + parking MCP servers
if [ $DRY -eq 1 ]; then pack patch --dry-run; else pack patch; fi

say "4. agent workspaces and role files"
if [ $DRY -eq 0 ]; then
  for r in worker toolsmith verifier; do
    mkdir -p "$STATE/workspace-$r" "$STATE/agents/$r/agent"
    install -m 644 "$PACK/roles/$r.AGENTS.md" "$STATE/workspace-$r/AGENTS.md"
  done
  mkdir -p "$ORCH_WS"
  pack block "$ORCH_WS/AGENTS.md" "$PACK/roles/orchestrator.block.md"
fi

say "5. restart gateway to load the agents"
if [ $DRY -eq 0 ]; then
  "$OC" gateway restart 2>&1 | tail -2 || true
  for _ in $(seq 1 30); do "$OC" gateway status 2>/dev/null | grep -qiE "running|active" && break; sleep 2; done
fi
say "done (check with: agent-spaghetti-healthcheck)"
