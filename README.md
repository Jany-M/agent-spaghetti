<div align="center">
  <img width="400" height="400" alt="logo_light" src="https://github.com/user-attachments/assets/2a4fab94-ac95-4e36-a97f-39aecd2b67df" />

# Agent Spaghetti

*Multi Agent Orchestrator for tools and LLMs that have no intention of cooperating.*

Your AI tools each live in their own world. Agent Spaghetti untangles them: it makes your agents hand work to each other, one step at a time, on the LLM you choose, local or online.
</div>

## What it does

Agent Spaghetti is a **switchboard** for the AI tools on your machine. Any tool can hand a task to any other tool, and the result comes back to the one that asked: coding agents (Claude Code, Codex, OpenCode, Cline, Kilo, OpenClaw, …), IDE chats (VS Code, Cursor, …), desktop apps (Claude Desktop, AnythingLLM, …) and models (LM Studio, Ollama, llama.cpp, vLLM or a hosted API). No tool sits in the middle and none is preferred: you decide who does what.

- **See** what is installed and running, on Windows and in your WSL distros, and which model each agent uses.
- **Connect** your tools once (one click each): they get the `agent-spaghetti` tools (`delegate`, `targets`, `run_status`, `report`).
- **Hand off** a task from any connected tool, or from the tray, to any target. Free local models run at once; anything that may cost money asks you first. Every hand-off is recorded (who, what kind, why, outcome, cost, result).

<div align="center">
<img width="380" height="520" alt="taskbar_dark" src="https://github.com/user-attachments/assets/345fcd88-737a-4870-94dc-856b6ffc28cd" />
<img width="380" height="520" alt="preview" src="https://github.com/user-attachments/assets/0ae9022f-b21b-433b-82f4-7bc498c24006" />
<img width="380" height="520" alt="preview (3)" src="https://github.com/user-attachments/assets/04cef01e-a242-4faf-96bc-526c13eaab41" />
<img width="380" height="520" alt="preview (4)" src="https://github.com/user-attachments/assets/8d2be3b2-9f36-4d49-afd1-bec7fbae0096" />
<img width="380" height="520" alt="preview (6)" src="https://github.com/user-attachments/assets/29905432-99db-410f-b455-c4959d369de3" />
</div>

## Install (Windows 11 + WSL)

`npm install`, then `npm run tray` (Node.js 24). The first start adds an **Agent Spaghetti** shortcut to the desktop and the Start menu; from then on, click it. "Start tray at login" in the tray menu starts it with Windows. Everything the tray does is also a command: `node packages/cli/src/index.ts help`.

Status keeps itself current: running tools and model servers are re-checked every few seconds, a tool starting or stopping triggers a rescan, and a full rescan runs every 10 minutes (Settings → `scan.everyMin`).

## Connect your tools

**Tools** lists everything found, by type. Each tool you can connect asks once: *Connect for this session*, *Always connect* or *Don't connect* (change it any time in its row). Connected tools get the `agent-spaghetti` MCP server and a short skill that tells their agent how to hand off work.

## Hand off work and get results back

- From a connected tool: ask its agent to delegate (for example "have the local model write the tests, then Claude Code review them"), or in Cursor start a prompt with `>>target ` to send it without using Cursor's model.
- From the tray: **Runs → New task**. From a terminal: `delegate <target> <task> [--model <m>] [--then <target>,…]`.
- **Chains:** a hand-off can name next steps (`then`); each step gets the previous result, and the last result goes back to whoever asked: straight into the waiting call, into the caller's own session when it can continue one, into its chat (VS Code), or as a result waiting for it (`run_status`, the tray tells you).
- **`auto`** lets Agent Spaghetti pick the target: the best free one, or the one its dispatcher model chooses (Settings → `dispatcher.model`, off by default). With a dispatcher model set, a hand-off that stops progressing is passed to another target once.
- Targets take tasks through the standard each tool offers: the model API (LM Studio, Ollama, …), ACP (OpenCode, Kilo, Cline), their own CLI (Claude Code, Codex, OpenClaw) or their chat (VS Code). **Tools** shows which ones can take tasks now.
- **Runs** shows each hand-off chain, where its result went and the result; rate it or cancel it there.
- Third-party integrations (JSON files in the data folder's `integrations/`) do nothing until you allow each action (Tools → More).

## Choose the LLM per tool (model gateway)

Tools that accept a custom OpenAI-compatible endpoint (VS Code chat, OpenCode, Kilo, Cline, Roo Code, Continue) can use Agent Spaghetti's model gateway, so you pick each tool's LLM in one place, local or online.

1. Settings → `gateway.port` (e.g. `4141`): the gateway listens on `127.0.0.1` only.
2. Tools → the tool → **Use the gateway**: a key for that tool, shown once, with the exact steps for it. The tool asks for model `auto`.
3. Tools → the tool → **Model**: `auto` (the best free model loaded) or a specific one. Change it here any time; the tool needs no change.

Local models answer at once; a paid one (OpenAI or Anthropic API, found when `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` is set) asks you first, as hand-offs do. Every request is in **Runs** (no prompt text is stored). Limits: VS Code's inline completions stay with GitHub; Cursor cannot reach a local endpoint (its requests go through its servers), so it works through hand-offs instead.

## Per-tool notes

- **OpenClaw:** Tools → OpenClaw → **Set up** installs its multi-step workflow pack (roles, settings, helpers; **Dry run** first if you like, **Check** any time). It needs a running gateway and `python3` on the gateway host. The model it uses is the setting `openclaw.model`: `auto` (keep the current one while it answers, else the best loaded local model), `keep`, or `<server>:<model>` from `targets`.
- **Cursor:** cannot use a local model as its own model (its servers can't reach your machine), so it works through MCP and the `>>` prefix.

## License

[Business Source License 1.1](LICENSE): free for personal and internal use, not for selling or hosting as a service. Each version becomes Apache-2.0 2 years after its release.
