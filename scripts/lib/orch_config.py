#!/usr/bin/env python3
"""Build the machine-specific part of the OpenClaw config patch.

Never hard-codes a provider, host, model or path. Modes (PROVIDER_MODE):
  auto    (default) keep OpenClaw's current primary model if its endpoint answers (or has no endpoint to
          probe, e.g. OpenClaw's own managed llama.cpp / a hosted API); otherwise detect a local server.
  keep    never touch provider or primary model; only set the request timeout.
  follow  always switch to whatever local server/model is loaded right now (LM Studio, Ollama, llama.cpp, vLLM).
  manual  use PROVIDER_ID / BASE_URL / MODEL_ID (+ API, CONTEXT_WINDOW, MAX_TOKENS) from the environment.

Usage: orch_config.py --config <openclaw.json> --out <patch.json> [--detect-only]
"""
import argparse, json, os, re, subprocess, sys, urllib.error, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--config", required=True)
ap.add_argument("--out")
ap.add_argument("--detect-only", action="store_true")
A = ap.parse_args()

E = os.environ.get
MODE = (E("PROVIDER_MODE") or "auto").lower()
TIMEOUT = int(E("PROVIDER_TIMEOUT_SECONDS") or 900)
cfg = json.load(open(A.config, encoding="utf-8"))
providers = cfg.get("models", {}).get("providers", {})
primary = (cfg.get("agents", {}).get("defaults", {}).get("model") or {})
primary = primary.get("primary") if isinstance(primary, dict) else primary


def say(m):
    print("   " + m, file=sys.stderr)


def get(url, timeout=3, key=None):
    """-> (status, parsed-json-or-None). Any HTTP answer (even 401) means the server is there."""
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + key} if key else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(2_000_000)
            try:
                return r.status, json.loads(body)
            except Exception:
                return r.status, None
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return None, None


def split_ref(ref):
    """'lmstudio/google/gemma' -> ('lmstudio', 'google/gemma') using configured provider ids."""
    if not ref:
        return None, None
    for pid in sorted(providers, key=len, reverse=True):
        if ref.startswith(pid + "/"):
            return pid, ref[len(pid) + 1:]
    p, _, m = ref.partition("/")
    return p, m


def candidate_hosts():
    hs = ["localhost", "127.0.0.1"]
    try:
        gw = subprocess.run(["ip", "route"], capture_output=True, text=True).stdout
        m = re.search(r"^default via (\S+)", gw, re.M)
        if m:
            hs.append(m.group(1))
    except Exception:
        pass
    hs.append("host.docker.internal")
    hs += (E("LLM_HOSTS") or "").split()
    for p in providers.values():
        m = re.match(r"https?://([^:/]+)", p.get("baseUrl", "") or "")
        if m:
            hs.append(m.group(1))
    seen, out = set(), []
    for h in hs:
        if h not in seen:
            seen.add(h)
            out.append(h)
    return out


def probe_lmstudio(h):
    st, d = get("http://%s:1234/api/v0/models" % h)
    if st == 200 and isinstance(d, dict) and "data" in d:
        llms = [m for m in d["data"] if m.get("type") in ("llm", "vlm")]
        if not llms:
            return None
        llms.sort(key=lambda m: (m.get("state") != "loaded", "tool_use" not in (m.get("capabilities") or []), m["id"]))
        m = llms[0]
        return dict(kind="lmstudio", pid="lmstudio", base="http://%s:1234/v1" % h, model=m["id"],
                    ctx=m.get("loaded_context_length") or m.get("max_context_length"),
                    loaded=m.get("state") == "loaded", models=[x["id"] for x in llms])
    st, d = get("http://%s:1234/v1/models" % h)  # older LM Studio
    if st == 200 and isinstance(d, dict) and d.get("data"):
        ids = [x["id"] for x in d["data"] if "embed" not in x["id"].lower()]
        if ids:
            return dict(kind="lmstudio", pid="lmstudio", base="http://%s:1234/v1" % h, model=ids[0], ctx=None,
                        loaded=True, models=ids)
    return None


def probe_ollama(h):
    st, ps = get("http://%s:11434/api/ps" % h)
    if st != 200:
        return None
    loaded = [m["name"] for m in (ps or {}).get("models", [])]
    st, tags = get("http://%s:11434/api/tags" % h)
    allm = [m["name"] for m in (tags or {}).get("models", []) if "embed" not in m["name"].lower()]
    pick = (loaded or allm or [None])[0]
    if not pick:
        return None
    return dict(kind="ollama", pid="local-ollama", base="http://%s:11434/v1" % h, model=pick, ctx=None,
                loaded=bool(loaded), models=allm)


def probe_openai(h, port, kind):
    st, d = get("http://%s:%d/v1/models" % (h, port))
    if st == 200 and isinstance(d, dict) and d.get("data"):
        ids = [x["id"] for x in d["data"] if "embed" not in x["id"].lower()]
        if ids:
            return dict(kind=kind, pid="local-" + kind, base="http://%s:%d/v1" % (h, port), model=ids[0], ctx=None,
                        loaded=True, models=ids)
    return None


def detect():
    for h in candidate_hosts():
        for fn in (probe_lmstudio, probe_ollama, lambda x: probe_openai(x, 8080, "llamacpp"),
                   lambda x: probe_openai(x, 8000, "vllm")):
            r = fn(h)
            if r:
                return r
    return None


def endpoint_ok(pid):
    p = providers.get(pid)
    if not p or not p.get("baseUrl"):
        return True  # nothing to probe (managed/hosted/built-in): trust it
    st, _ = get(p["baseUrl"].rstrip("/") + "/models", timeout=5)
    return st is not None


def build_provider_patch(d, keep_model=None):
    pid = d["pid"]
    existing = providers.get(pid, {})
    models = [m for m in existing.get("models", [])]
    model = keep_model if keep_model and keep_model in d["models"] else d["model"]
    ctx = int(d["ctx"] or E("CONTEXT_WINDOW") or 32768)
    ent = next((m for m in models if m.get("id") == model), None)
    if ent is None:
        models.append({"id": model, "name": model, "contextWindow": ctx, "maxTokens": int(E("MAX_TOKENS") or 8192)})
    elif d["ctx"] and ent.get("contextWindow") != ctx:
        ent["contextWindow"] = ctx  # declared window must match what the server really loaded
    p = {"baseUrl": d["base"], "timeoutSeconds": TIMEOUT, "models": models}
    if not existing:
        p.update({"apiKey": E("API_KEY") or "local", "api": "openai-completions"})
    return pid, model, p


patch = {}
choice = None  # (pid, model, provider-patch)

if A.detect_only:
    d = detect()
    print(json.dumps(d, indent=1))
    sys.exit(0 if d else 1)

if MODE == "manual":
    pid, base, model = E("PROVIDER_ID"), E("BASE_URL"), E("MODEL_ID")
    if not (pid and base and model):
        sys.exit("PROVIDER_MODE=manual needs PROVIDER_ID, BASE_URL and MODEL_ID")
    d = dict(pid=pid, base=base, model=model, ctx=E("CONTEXT_WINDOW"), models=[model])
    choice = build_provider_patch(d)
    say("manual provider: %s/%s @ %s" % (choice[0], choice[1], base))
else:
    cur_pid, cur_model = split_ref(primary)
    need_detect = MODE == "follow" or (MODE == "auto" and (not primary or not endpoint_ok(cur_pid)))
    if MODE == "keep" or not need_detect:
        if primary:
            say("keeping current primary model %s (%s)" % (primary, "endpoint answers" if providers.get(cur_pid, {}).get("baseUrl") else "no local endpoint to probe"))
            if providers.get(cur_pid, {}).get("baseUrl"):
                choice = (cur_pid, cur_model, {"timeoutSeconds": TIMEOUT})
            elif cur_pid in providers:
                choice = (cur_pid, cur_model, {"timeoutSeconds": TIMEOUT})
        else:
            say("no primary model configured and PROVIDER_MODE=keep: nothing to set")
    else:
        d = detect()
        if not d:
            sys.exit("no local LLM server found (tried LM Studio :1234, Ollama :11434, llama.cpp :8080, vLLM :8000 on %s).\n"
                     "Start one, set LLM_HOSTS, or use PROVIDER_MODE=manual." % ", ".join(candidate_hosts()))
        keep = cur_model if (MODE == "auto" and cur_pid == d["pid"]) else None
        choice = build_provider_patch(d, keep)
        say("%s: %s/%s @ %s%s" % ("following loaded model" if MODE == "follow" else "primary endpoint was down; re-detected",
                                  choice[0], choice[1], d["base"],
                                  "" if d["loaded"] else "  (not loaded yet; server will load it on first request)"))

if choice:
    pid, model, p = choice
    patch.setdefault("models", {}).setdefault("providers", {})[pid] = p
    if MODE in ("follow", "manual") or "models" in p or (primary is None):
        patch.setdefault("agents", {}).setdefault("defaults", {})["model"] = {"primary": "%s/%s" % (pid, model)}

# MCP: park every configured server (off by default; the toolsmith agent enables on demand)
srv = cfg.get("mcp", {}).get("servers", {})
if srv:
    patch["mcp"] = {"servers": {n: {"enabled": False} for n in srv}}

json.dump(patch, open(A.out, "w"), indent=1)
