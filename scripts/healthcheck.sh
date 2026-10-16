#!/usr/bin/env bash
# Read-only wiring report. Exit code = number of problems found. Works with any provider.
if ! command -v openclaw >/dev/null 2>&1; then
  for d in "${OPENCLAW_STATE_DIR:-}/tools/node/bin" "$HOME/.openclaw/tools/node/bin" "$HOME/.local/bin" /usr/local/bin /opt/homebrew/bin; do
    [ -x "$d/openclaw" ] && PATH="$d:$PATH" && break
  done
fi
BAD=0
ok()  { printf '  OK    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; BAD=$((BAD+1)); }
clean() { sed 's/\x1b\[[0-9;]*m//g'; }
CFG="$(openclaw config file 2>/dev/null | clean | tail -1)"; CFG="${CFG/#\~/$HOME}"
[ -f "$CFG" ] || { echo "OpenClaw config not found"; exit 1; }

echo "gateway"
openclaw gateway status 2>&1 | clean | grep -qiE "running|active|enabled" && ok "gateway service up" || bad "gateway not running"

echo "config"
python3 - "$CFG" <<'PY' || BAD=$((BAD+1))
import json, subprocess, sys, urllib.request, urllib.error
c = json.load(open(sys.argv[1]))
a = c.get("agents", {}); d = a.get("defaults", {}); e = a.get("entries", {})
ag = json.loads(subprocess.run(["openclaw", "agents", "list", "--json"], capture_output=True, text=True).stdout or "[]")
orch = next((x["id"] for x in ag if x.get("isDefault")), "main")
prim = d.get("model", {}); prim = prim.get("primary") if isinstance(prim, dict) else prim
prov = c.get("models", {}).get("providers", {})
pid = next((p for p in sorted(prov, key=len, reverse=True) if prim and prim.startswith(p + "/")), None)
res = []
res.append(("primary model set (%s)" % prim, bool(prim)))
if pid and prov[pid].get("baseUrl"):
    url = prov[pid]["baseUrl"].rstrip("/") + "/models"
    try:
        urllib.request.urlopen(url, timeout=6); up = True
    except urllib.error.HTTPError:
        up = True
    except Exception:
        up = False
    res.append(("LLM endpoint answers (%s)" % prov[pid]["baseUrl"], up))
    res.append(("provider timeoutSeconds >= 300", (prov[pid].get("timeoutSeconds") or 0) >= 300))
elif prim:
    res.append(("LLM endpoint: none to probe (managed/hosted provider '%s')" % pid, True))
res += [
 ("maxConcurrent <= 2", d.get("maxConcurrent", 99) <= 2),
 ("subagents.maxConcurrent == 1", d.get("subagents", {}).get("maxConcurrent") == 1),
 ("tools.toolSearch == false", c.get("tools", {}).get("toolSearch") is False),
 ("agents worker/toolsmith/verifier exist", all(x in e for x in ("worker", "toolsmith", "verifier"))),
 ("orchestrator agent '%s' uses minimal profile" % orch, e.get(orch, {}).get("tools", {}).get("profile") == "minimal"),
]
srv = c.get("mcp", {}).get("servers", {}); on = [n for n, v in srv.items() if v.get("enabled", True)]
res.append(("MCP servers parked (on: %s)" % (", ".join(on) or "none"), len(on) <= 2))
bad = 0
for n, v in res:
    print("  %s  %s" % ("OK  " if v else "FAIL", n)); bad += (not v)
sys.exit(1 if bad else 0)
PY

echo "orchestrator files"
WS="$(openclaw agents list --json 2>/dev/null | python3 -c "
import json,sys,os
a=json.load(sys.stdin); p=next((x for x in a if x.get('isDefault')), a[0])
print(os.path.expanduser(p.get('workspace','')))")"
[ -f "$WS/AGENTS.md" ] && grep -q "BEGIN ORCHESTRATOR" "$WS/AGENTS.md" && ok "AGENTS.md has orchestrator block" || bad "AGENTS.md block missing in $WS"
if [ -f "$WS/AGENTS.md" ] && grep -q "sessions_spawn" "$WS/AGENTS.md" && grep -q "sessions_yield" "$WS/AGENTS.md" && grep -q "jobctl brief" "$WS/AGENTS.md"; then
  ok "hand-off text intact (tool names present)"; else bad "hand-off text missing or corrupted"; fi
command -v jobctl >/dev/null && ok "jobctl on PATH" || bad "jobctl not on PATH (is ~/.local/bin in PATH?)"
command -v ocmcp  >/dev/null && ok "ocmcp on PATH"  || bad "ocmcp not on PATH"

echo "jobs"; (jobctl status 2>/dev/null || echo "no jobs") | sed 's/^/  /'
echo; [ $BAD -eq 0 ] && echo "ALL GOOD" || echo "$BAD problem(s)"
exit $BAD
