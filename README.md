<div align="center">
  <img width="400" height="400" alt="logo_light" src="https://github.com/user-attachments/assets/2a4fab94-ac95-4e36-a97f-39aecd2b67df" />

# Agent Spaghetti

*Multi Agent Orchestrator for tools and LLMs that have no intention of cooperating.*

Your AI tools each live in their own world. Agent Spaghetti untangles them: it makes your tools' agents hand work to each other, on the LLM you choose, local or online.
</div>

## What it does

Agent Spaghetti is a **switchboard** for the AI tools you already use on your machine.
Any tool can hand a task to any other tool, and the result comes back to the one that asked: coding agents, IDE chats, desktop apps and models.

No more single tool hoarding all the tasks and draining your API or subscription quotas by doing it all by itself.
It's time to organize agents workload better and make the most of ever raising tokens and plans cost.
You decide who does what, when you want them to.

- **See** what is installed and running, on Windows and in your WSL distros, and which model each agent uses.
- **Connect** your tools once (one click each): they get the `agent-spaghetti` tools (`delegate`, `targets`, `run_status`, `report`).
- **Hand off** a task from any connected tool, or from the tray, to any target. Free local models run at once; anything that may cost money (e.g. delegating a task to your Copilot in VSCode, or your Claude CLI etc.) asks you first, before delegating. Every hand-off is recorded (who, what kind, why, outcome, cost, result).

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

- From a connected tool, in its own chat (examples; target names come from **Tools**):

  | Tool | Type | |
  |---|---|---|
  | any | `have the local model write the tests, then Claude Code review them, then hand it back to me` | plain words: its agent calls `delegate` |
  | VS Code (Copilot or Claude harness) | pick **agent-spaghetti** in the agent list, then `lmstudio summarize README.md` | the first word is the target; none: you pick |
  | VS Code (Local harness) | `/mcp.agent-spaghetti.delegate` | a form with a target list |
  | Claude Code | `@`, pick the **agent-spaghetti** agent or a target (`@agent-spaghetti:target://openclaw review this`) | `@` lists both |
  | Cursor, Claude Code | `>>openclaw >>claude-cli review src/app.ts`, then Enter | sent straight to the targets, not to the tool's model; nothing pops up while typing |

  The open workspace goes along as the folder to work in, and attached files go too: agents get their paths (translated for WSL), models get their text. No target named? The tool asks you to pick one (or `auto`), and a paid target asks for approval right there or in the tray. Agents edit files only for editing kinds (code-edit, refactor, tests, docs). A `>>` result also lands in `<workspace>/.agent-spaghetti/results/<run>.md`.

  VS Code's chat runs on a *harness* you pick per session (Local, Copilot, Claude); what each offers differs, the table says which. After connecting, reload the tool once so it picks up the server, agent and hook.
- From the tray: **Runs → New task**. From a terminal: `delegate <target> <task> [--model <m>] [--then <target>,…]`.
- **Chains:** a hand-off can name next steps (`then`); each step gets the previous result, and the last result goes back to whoever asked: straight into the waiting call, into the caller's own session when it can continue one, into its chat (VS Code), or as a result waiting for it (`run_status`, the tray tells you).
- **Kind and difficulty:** a tool may say what sort of work a task is and how demanding (`kind`, `difficulty`); when it doesn't, Agent Spaghetti sets both from built-in rules (English and Italian) and shows them in Runs and Live, with how sure it is.
- **`auto`** lets Agent Spaghetti pick the target for the task's kind and difficulty: free before paid, a target big enough for it (model size from its name; a free one a size smaller may try first), then how that target's past runs of that kind went (finished, failed, your Good/Bad/Redo). If the target it chose fails or answers nothing, the next one tries, once per chain (a paid one asks first). **Routing** shows the order for each kind of task and why; there you can make a target **First** or **Never** for a kind and switch learning, stretching and escalation off. A dispatcher model (Settings → `dispatcher.model`, off by default) can pick among the ranked targets instead; with one set, a hand-off that stops progressing is passed to another target once.
- Targets take tasks through the standard each tool offers: the model API (LM Studio, Ollama, …), ACP (OpenCode, Cline), their own CLI (Claude Code, Codex, Hermes, Kilo, OpenClaw) or their chat (VS Code). ACP and CLI targets need the tool's CLI: the Kilo, Cline and Codex apps bundle one (Cline's needs a sign-in first: `cline auth`); the OpenCode app doesn't (`npm i -g opencode-ai`). **Tools** shows which ones can take tasks now.
- **An agent's model:** a task can name one (`--model`); otherwise the agent uses its own default, or the one you set per agent in Settings → `delegate.models` (`<target>=<model>`, e.g. `kilo=kilo/kilo-auto/free`). An agent that runs a model on this machine (Hermes with a local server) counts as free.
- **Runs** shows each hand-off chain, where its result went and the result; rate it or cancel it there. **N waiting** lists results whose caller has not collected them yet (it asks with `run_status`); open one to read it or **Dismiss** it.
- **Live** (popover header, or tray menu → Live activity): a small window that stays on top while you work and shows each step as it happens, newest on top: who handed what to whom, Agent Spaghetti's choices, questions, the task as sent and the answer as it streams. Click a line to read it in full, `#n` to follow one run.
- Third-party integrations (JSON files in the data folder's `integrations/`) do nothing until you allow each action (Tools → More).

## Choose the LLM per tool (model gateway)

Tools that accept a custom OpenAI-compatible endpoint (VS Code chat, OpenCode, Kilo, Cline, Zoo Code, Continue) can use Agent Spaghetti's model gateway, so you pick each tool's LLM in one place, local or online.

1. Settings → `gateway.port` (e.g. `4141`): the gateway listens on `127.0.0.1` only.
2. Tools → the tool → **Use the gateway**: a key for that tool, shown once, with the exact steps for it. The tool asks for model `auto`.
3. Tools → the tool → **Model**: `auto` (the best free model loaded) or a specific one. Change it here any time; the tool needs no change.

Local models answer at once; a paid one (OpenAI or Anthropic API, found if `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` is set) asks you first, as hand-offs do. Every request is in **Runs** (no prompt text is stored). 

## Works with

- anthropic-api
- anythingllm
- chatgpt-desktop
- claude-cli
- claude-desktop
- cline
- codex
- continue
- cursor
- kilo
- llamacpp
- lmstudio
- mempalace
- ollama
- openai-api
- openclaw
- opencode
- vllm
- vscode
- windsurf
- zoo-code

## Per-tool notes

- **OpenClaw:** Tools → OpenClaw → **Set up** installs its multi-step workflow pack (roles, settings, helpers; **Dry run** first if you like, **Check** any time). It needs a running OpenClaw gateway and `python3` on its host. The model it uses is the setting `openclaw.model`: `auto` (keep the current one while it answers, else the best loaded local model), `keep`, or `<server>:<model>` from `targets`.
- **Cursor:** cannot use a local model/endpoint as its own model (its servers can't reach your machine), so it works through hand-offs instead, via local MCP and the `>>` prefix.
- **VS Code**'s inline completions stay with GitHub.

## License

[Business Source License 1.1](LICENSE): free for personal and internal use, not for selling or hosting as a service. Each version becomes Apache-2.0 2 years after its release.
