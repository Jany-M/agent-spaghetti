# Agent Spaghetti

*Multi Agent Orchestrator for tools and LLMs that have no intention of cooperating.*

Your AI tools each live in their own world. Agent Spaghetti untangles them: it makes your agents hand work to each other, one step at a time, on the LLM you choose, local or online.

## What you get today

**Reliable multi-step agent workflows for [OpenClaw](https://docs.openclaw.ai) with a local LLM** (LM Studio, Ollama, llama.cpp, vLLM or a hosted API), on Windows 11 / WSL.

- Long tasks are split into steps and handed from agent to agent, saved to files, so a crash, restart or new chat resumes where it stopped.
- One step at a time, so a single local GPU never gets overloaded.
- Tools are switched on only when a step needs them.
- Survives reinstalls of OpenClaw or your LLM server: run one command and it is back.

## Install (Windows + WSL)

```powershell
.\apply.ps1
```

Check it any time with `.\healthcheck.ps1`. Linux and macOS: `npm run build`, then `packs/openclaw/scripts/apply.sh` and `agent-spaghetti-healthcheck`.

Needs OpenClaw with a working gateway (its bundled Node.js is used), plus `python3` (for `jobctl`) and `tar` on the gateway host, and Node.js 24 on Windows to build once. Works best with a model that handles tool calls well.

## Choosing the LLM

By default it keeps the model OpenClaw already uses. Re-point it with:

```powershell
.\apply.ps1 -Mode follow    # use whatever model the local server has loaded now
.\apply.ps1 -DryRun         # preview, change nothing
```

Other modes (`keep`, `manual`) are described in `packs/openclaw/config/overrides.env.example`.

## The daemon, the tray and delegation

`npm install`, then (Node.js 24 on Windows):

```powershell
npm run tray                          # tray icon: status on hover, questions to answer; starts the daemon if needed
node packages/cli/src/index.ts help   # or the CLI (the daemon: `... daemon`)
```

- **See:** `scan` finds AI tools, local model servers and agents on Windows and in running WSL distros; `status` shows what is running now.
- **Delegate:** `delegate <target> <task>` hands a task to a local model (LM Studio, Ollama, llama.cpp, vLLM) or to Claude Code. Free local models run at once, one request at a time per server; anything that may cost money asks you first (tray or `answer <id> allow|deny`). `targets` lists what is available, `runs` keeps the record (who, what kind, why, outcome, cost, result file).
- **Connect clients:** `connect openclaw | claude-cli | cursor` gives a tool the `agent-spaghetti` MCP server (`delegate`, `targets`, `run_status`). In Cursor, a prompt starting with `>>target ` goes straight to that target without using Cursor's model; the result lands in `.agent-spaghetti/results/` in the workspace.
- **Third-party integrations** (JSON files in the data folder's `integrations/`) do nothing until you allow each action (`permissions`, `allow`, `deny`).

Limits: Cursor can't use a local model as its own model (its servers can't reach your machine), so Cursor works through MCP and the `>>` hook instead.

## License

[Business Source License 1.1](LICENSE): free for personal and internal use, not for selling or hosting as a service. Each version becomes Apache-2.0 on 2029-10-16 or four years after its release, whichever comes first.
