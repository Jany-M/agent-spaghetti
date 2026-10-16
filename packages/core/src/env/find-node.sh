# Prints the first Node.js >= 20 it finds (PATH, then common per-user installs) or nothing.
# The one copy: the hub runs it in WSL distros (env/wsl.ts) and the OpenClaw pack's apply.sh runs it too.
for n in "$(command -v node 2>/dev/null)" "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/tools/node/bin/node" "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.volta/bin/node" /usr/local/bin/node /usr/bin/node; do
  [ -x "$n" ] || continue
  m=$("$n" -p "process.versions.node.split('.')[0]" 2>/dev/null)
  if [ "${m:-0}" -ge 20 ] 2>/dev/null; then echo "$n"; break; fi
done
