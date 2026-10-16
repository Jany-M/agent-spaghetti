#!/usr/bin/env bash
# Idempotent. Run on the machine/distro that hosts the OpenClaw gateway (apply.ps1 does that for Windows+WSL).
#   apply.sh [--dry-run]
# Discovers the OpenClaw binary, state dir, default agent and LLM at run time; nothing is hard-coded.
set -euo pipefail
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say() { printf '\n== %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }
clean() { sed 's/\x1b\[[0-9;]*m//g'; }

# --- optional user overrides (see config/overrides.env.example)
if [ -f "$REPO/config/overrides.env" ]; then set -a; . "$REPO/config/overrides.env"; set +a; fi

# --- locate openclaw
if ! command -v openclaw >/dev/null 2>&1; then
  for d in "${OPENCLAW_STATE_DIR:-}/tools/node/bin" "$HOME/.openclaw/tools/node/bin" "$HOME/.local/bin" /usr/local/bin /opt/homebrew/bin; do
    [ -x "$d/openclaw" ] && PATH="$d:$PATH" && break
  done
fi
command -v openclaw >/dev/null 2>&1 || die "openclaw not found on PATH. Install OpenClaw first."
CFG="$(openclaw config file 2>/dev/null | clean | tail -1)"; CFG="${CFG/#\~/$HOME}"
[ -f "$CFG" ] || die "OpenClaw config not found (got '$CFG'). Run 'openclaw onboard' first."
STATE="$(dirname "$CFG")"
OD="$STATE/agent-spaghetti"
# migrate the pre-rename folder (was <state>/orchestrator)
if [ $DRY -eq 0 ] && [ -d "$STATE/orchestrator" ] && [ ! -e "$OD" ]; then mv "$STATE/orchestrator" "$OD"; fi
echo "openclaw: $(command -v openclaw)"; echo "config  : $CFG"

# --- orchestrator agent = default agent (or ORCH_AGENT_ID)
read -r ORCH ORCH_WS < <(python3 - <<'PY'
import json, os, subprocess
ag = json.loads(subprocess.run(["openclaw", "agents", "list", "--json"], capture_output=True, text=True).stdout or "[]")
want = os.environ.get("ORCH_AGENT_ID")
pick = next((a for a in ag if a["id"] == want), None) if want else None
pick = pick or next((a for a in ag if a.get("isDefault")), None) or (ag[0] if ag else {"id": "main", "workspace": ""})
print(pick["id"], os.path.expanduser(pick.get("workspace") or ""))
PY
)
[ -n "$ORCH_WS" ] || ORCH_WS="$STATE/workspace"
echo "orchestrator agent: $ORCH  (workspace $ORCH_WS)"

say "1. backup"
if [ $DRY -eq 0 ]; then
  B="$STATE/agent-spaghetti-backups/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$B"
  cp -a "$CFG" "$B/"; [ -f "$ORCH_WS/AGENTS.md" ] && cp -a "$ORCH_WS/AGENTS.md" "$B/"
  chmod -R go-rwx "$STATE/agent-spaghetti-backups"; echo "backup: $B"
else echo "(dry-run: skipped)"; fi

say "2. install helper scripts"
if [ $DRY -eq 0 ]; then
  mkdir -p "$OD/bin/lib" "$OD/mcp" "$STATE/jobs" "$HOME/.local/bin"
  install -m 755 "$REPO/scripts/jobctl" "$REPO/scripts/ocmcp" "$OD/bin/"
  install -m 755 "$REPO/scripts/healthcheck.sh" "$OD/bin/agent-spaghetti-healthcheck"
  install -m 644 "$REPO/scripts/lib/orch_config.py" "$OD/bin/lib/"
  install -m 644 "$REPO/mcp/catalog.json" "$OD/mcp/catalog.json"
  rm -f "$HOME/.local/bin/orch-healthcheck"
  for t in jobctl ocmcp agent-spaghetti-healthcheck; do ln -sf "$OD/bin/$t" "$HOME/.local/bin/$t"; done
  echo "installed to $OD/bin (symlinked in ~/.local/bin; make sure that is on PATH)"
fi

say "3. config patch"
# 3a. static workflow settings (JSON5, validated and merged by OpenClaw)
STATIC="$(mktemp --suffix=.json5)"; DYN="$(mktemp --suffix=.json)"; trap 'rm -f "$STATIC" "$DYN"' EXIT
sed -e "s#{{STATE}}#$STATE#g" -e "s#{{ORCH}}#$ORCH#g" "$REPO/config/orchestrator.patch.json5" > "$STATIC"
if [ $DRY -eq 1 ]; then openclaw config patch --file "$STATIC" --dry-run | clean; else openclaw config patch --file "$STATIC" | clean; fi
# 3b. machine-specific: LLM endpoint/model/timeout + parking MCP servers
python3 "$REPO/scripts/lib/orch_config.py" --config "$CFG" --out "$DYN"
if [ "$(tr -d ' \n\t' < "$DYN")" = "{}" ]; then echo "nothing machine-specific to change"; : > "$DYN"; echo '{"agents":{}}' > "$DYN"
elif ! openclaw config patch --file "$DYN" --dry-run >/dev/null 2>&1; then
  echo "note: provider block rejected by schema; applying without it"
  python3 - "$DYN" <<'PY'
import json, sys
p = json.load(open(sys.argv[1])); p.pop("models", None); p.get("agents", {}).pop("defaults", None)
p = {k: v for k, v in p.items() if v}
json.dump(p, open(sys.argv[1], "w"))
PY
fi
if [ $DRY -eq 1 ]; then openclaw config patch --file "$DYN" --dry-run | clean; else openclaw config patch --file "$DYN" | clean; fi

say "4. agent workspaces and role files"
if [ $DRY -eq 0 ]; then
  for r in worker toolsmith verifier; do
    mkdir -p "$STATE/workspace-$r" "$STATE/agents/$r/agent"
    install -m 644 "$REPO/roles/$r.AGENTS.md" "$STATE/workspace-$r/AGENTS.md"
  done
  mkdir -p "$ORCH_WS"; [ -f "$ORCH_WS/AGENTS.md" ] || : > "$ORCH_WS/AGENTS.md"
  # Insert/replace the orchestrator section between stable markers. Text comes from a file, never a shell string.
  python3 - "$ORCH_WS/AGENTS.md" "$REPO/roles/orchestrator.block.md" <<'PY'
import re, sys
path, blockf = sys.argv[1:3]
doc = open(path, encoding="utf-8").read()
block = open(blockf, encoding="utf-8").read().strip()
B = "<!-- BEGIN ORCHESTRATOR (managed by agent-spaghetti; edit roles/orchestrator.block.md) -->"
OLD = re.compile(r"<!-- BEGIN ORCHESTRATOR \(managed by [^)]*\) -->.*?<!-- END ORCHESTRATOR -->\n?", re.S)  # also replaces pre-rename blocks
E = "<!-- END ORCHESTRATOR -->"
new = "%s\n%s\n%s\n" % (B, block, E)
if OLD.search(doc):
    doc = OLD.sub(lambda m: new, doc, count=1)
else:
    m = re.search(r"^## Background Work and Completion Reporting.*?(?=^## |\Z)", doc, flags=re.S | re.M)
    doc = (doc[:m.start()] + new + "\n" + doc[m.end():]) if m else (doc.rstrip() + "\n\n" + new)
open(path, "w", encoding="utf-8").write(doc)
print("AGENTS.md orchestrator block applied")
PY
fi

say "5. restart gateway to load the agents"
if [ $DRY -eq 0 ]; then
  openclaw gateway restart 2>&1 | clean | tail -2 || true
  for _ in $(seq 1 30); do openclaw gateway status 2>/dev/null | grep -qiE "running|active" && break; sleep 2; done
  openclaw agents list 2>&1 | clean | grep -E "^- " || true
fi
say "done"
