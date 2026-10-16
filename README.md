<div align="center">
  <img width="400" height="400" alt="logo_light" src="https://github.com/user-attachments/assets/2a4fab94-ac95-4e36-a97f-39aecd2b67df" />

# Agent Spaghetti

*Multi Agent Orchestrator for tools and LLMs that have no intention of cooperating.*

Your AI tools each live in their own world. Agent Spaghetti untangles them: it makes your agents hand work to each other, one step at a time, on the LLM you choose, local or online.
</div>

## What you get today

**Reliable multi-step agent workflows for [OpenClaw](https://docs.openclaw.ai) with a local LLM** (LM Studio, Ollama, llama.cpp, vLLM or a hosted API), on Windows 11 / WSL.

- Long tasks are split into steps and handed from agent to agent, saved to files, so a crash, restart or new chat resumes where it stopped.
- One step at a time, so a single local GPU never gets overloaded.
- Tools are switched on only when a step needs them.
- Survives reinstalls of OpenClaw or your LLM server: set it up again with one click.

## Install (Windows + WSL)

`npm install` and `npm run tray` (Node.js 24 on Windows), then in the tray: **Tools → OpenClaw → Set up** (**Dry run** first if you like; **Check** any time later). Inside the distro, `agent-spaghetti-healthcheck` prints the same check. Without the tray: `node packages/cli/src/index.ts setup openclaw [--dry-run|--check]`.

Needs OpenClaw with a working gateway (in a running WSL distro, or on Linux/macOS), plus `python3` on the gateway host (for `jobctl`). Works best with a model that handles tool calls well.

## Choosing the LLM

By default (`auto`) the setup keeps the model OpenClaw already uses while it answers, else it picks the first local server with a loaded model. Pick one yourself in **Settings → openclaw.model**: `keep` (never touch it) or `<server>:<model>` from **Runs → New task** / `targets` (e.g. `lmstudio:<loaded model>`), then **Set up** again.

## The daemon, the tray and delegation

<img width="380" height="520" alt="taskbar_dark" src="https://github.com/user-attachments/assets/345fcd88-737a-4870-94dc-856b6ffc28cd" />

`npm install`, then (Node.js 24 on Windows):

```powershell
npm run tray  # tray icon: status on hover, questions to answer; starts the daemon if needed
node packages/cli/src/index.ts help   # or the CLI (the daemon: `... daemon`)
```

The first `npm run tray` adds an **Agent Spaghetti** shortcut to the desktop and the Start menu: from then on, click it to start the tray (and the daemon). "Start tray at login" in the tray menu starts it with Windows. Status keeps itself current: running tools and model servers are re-checked every few seconds, a tool starting or stopping triggers a rescan, and a full rescan runs every 10 minutes (`setting scan.everyMin`).

- **See:** `scan` finds AI tools, local model servers and agents on Windows and in running WSL distros; `status` shows what is running now.
- **Delegate:** `delegate <target> <task>` hands a task to a local model (LM Studio, Ollama, llama.cpp, vLLM), an OpenClaw agent (`--model <agent>`, also inside WSL) or Claude Code; an agent that delegates further while it works shows up as one chain in `runs <id>`. Free local models run at once, one request at a time per server; anything that may cost money asks you first (tray or `answer <id> allow|deny`). `targets` lists what is available, `runs` keeps the record (who, what kind, why, outcome, cost, result file).
- **Connect clients:** `connect openclaw | claude-cli | cursor | vscode | claude-desktop | anythingllm` gives a tool the `agent-spaghetti` MCP server (`delegate`, `targets`, `run_status`). In Cursor, a prompt starting with `>>target ` goes straight to that target without using Cursor's model; the result lands in `.agent-spaghetti/results/` in the workspace.
- **Third-party integrations** (JSON files in the data folder's `integrations/`) do nothing until you allow each action (`permissions`, `allow`, `deny`).

Limits: Cursor can't use a local model as its own model (its servers can't reach your machine), so Cursor works through MCP and the `>>` hook instead.

## License

[Business Source License 1.1](LICENSE): free for personal and internal use, not for selling or hosting as a service. Each version becomes Apache-2.0 2 years after its release.
