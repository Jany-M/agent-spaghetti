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

**From a connected tool**, in its own chat (target names come from **Tools**):

| Tool | Type | |
|---|---|---|
| any | `have the local model write the tests, then Claude Code review them, then hand it back to me` | plain words: its agent calls `delegate` |
| VS Code (Copilot or Claude harness) | pick **agent-spaghetti** in the agent list, then `lmstudio summarize README.md` | the first word is the target; none: you pick |
| VS Code (Local harness) | `/mcp.agent-spaghetti.delegate` | a form with a target list |
| Claude Code | `@`, pick the **agent-spaghetti** agent or a target (`@agent-spaghetti:target://lmstudio review this`) | `@` lists both |
| Cursor | `/delegate lmstudio summarize README.md` | the first word is the target (`auto` lets Agent Spaghetti choose), `>>next` adds a step |
| Cursor, Claude Code | `>>lmstudio >>claude-cli review src/app.ts`, then Enter | sent straight to the targets, not to the tool's model |

**From the tray:** Runs → New task. **From a terminal:** `delegate <target> <task> [--model <m>] [--then <target>,…]`.

- The open workspace goes along as the working folder; attached files go too (agents get paths, translated for WSL; models get the text). No target named: the tool asks you to pick one (or `auto`). Agents edit files only for editing kinds (code-edit, refactor, tests, docs). A `>>` result also lands in `<workspace>/.agent-spaghetti/results/<run>.md`. After connecting, reload the tool once.
- **Chains** (`then`): each step gets the previous result; the last one goes back to whoever asked (into the waiting call, the caller's own session, its chat, or as a result waiting for it).
- **Kind and difficulty** (`kind`, `difficulty`): a tool may say what a task is; otherwise built-in rules (English and Italian) set both, and Runs and Live show them.
- **Runs:** each chain, where its result went and the result. Grade it (Good / Bad / Redo), correct its kind, or cancel it. A tool can grade too (`run_status` with `grade: poor`). **N waiting** lists results nobody collected yet.
- **Live** (popover header, or tray → Live activity): an always-on-top window with each step as it happens. `#n` follows one run, **Stop #n** ends a hung one. Questions and answers are kept in the data folder.
- **Flow** (Home): your tools around Agent Spaghetti, lighting up while they work. **Open bigger** gives it its own window.
- Third-party integrations (JSON files in the data folder's `integrations/`) do nothing until you allow each action (Tools → More).

## How Agent Spaghetti chooses

**Cost.** Free tools run at once; paid ones, and ones it can't tell, ask first. Per tool, in order of priority:

1. Your word: **Tools → the tool → Cost** (`tools.cost`: `<tool>=free|metered|unknown`).
2. The model it is set to use, read from the tool's own config (Cline, Kilo, OpenCode; never any key): a free model (`:free`, `/free`, `-free`) = free; any other = unknown.
3. The tool's manifest.

**The model a task uses**, first match wins:

1. `--model` on the task.
2. Your `delegate.models` (below).
3. A tool with its own local model that isn't loaded: its first free agent (Hermes: a free profile).
4. Nothing set in the tool, so its free option:

   | Tool | Free option |
   |---|---|
   | Kilo, OpenCode | `openrouter/free` (OpenRouter's router; picks a free model that is up) if you have an OpenRouter key stored in the tool |
   | Kilo | otherwise `kilo/kilo-auto/free` |
   | OpenCode | otherwise `opencode/big-pickle` |
   | Cline | none documented (its free models rotate): stays as found |

5. The tool's own default.

**`auto`** picks the target for the task's kind and difficulty:

- Free before paid; a target big enough for the task (model size from its name; a free one a size smaller may try first); then how its past runs of that kind went (finished, failed, your grades).
- Research without files goes first to a tool that can search the web (Kilo, Cline, OpenCode and Hermes' researcher do); planning goes to the strongest target.
- **One local model server at a time:** LM Studio, then llama.cpp, then Ollama; the first one with a model loaded. A server with no model loaded is skipped: Agent Spaghetti never loads a model for you, so the task goes to the next free tool until you load one (Hermes can start its own model when a task needs it).
- A tool that would load its own local model isn't picked while another local model is loaded (name it to do that).
- A busy free agent is passed over for the next one in line, even when you named it (paid ones take several at once).
- If the chosen target fails or answers nothing, the next one tries, once per chain (paid ones ask first).

**Saving paid usage by itself:** connected tools hand some kinds of task to a free tool without being asked (default: summarize, research, docs, tests, review). They keep small tasks, planning and decisions. Restart a tool after changing the list.

## Settings

Settings, and Tools / Routing in the tray, change everything below. In a terminal: `settings`, `setting <key> <value>`.

| Setting (where) | Default | What it does |
|---|---|---|
| `tools.cost` (Tools → Cost) | none | `<tool>=free\|metered\|unknown`: your word on what a tool costs |
| `delegate.models` | none | `<tool>=<model>`, or per kind or difficulty `<tool>:<kind or difficulty>=<model>`; most specific wins. E.g. `claude-cli:medium=sonnet`, `claude-cli:heavy=opus`, `hermes:research=researcher` |
| `agents.use` (Tools → Its agents) | free-model agents on | `<tool>:<agent>=on\|off`. A tool's own agents (Hermes profiles) on a paid provider or with a local model of their own are off until you tick them; a paid one asks first |
| `routing.prefer` / `routing.never` (Routing) | none | `<kind>=<tool>`: tried first / never used for that kind |
| `routing.tiers` | from model size | `<tool>[:model]=light\|medium\|heavy`: the hardest task it takes |
| `routing.learn`, `.stretch`, `.escalate` | on | learn from past runs and grades; let a smaller free target try first; try the next target on failure |
| `routing.offload` (Routing) | summarize, research, docs, tests, review | kinds tools hand off on their own (none = only when you ask) |
| `dispatcher.model`, `dispatcher.stuckMin` | off, 10 | a model that picks among the ranked targets and moves a stuck hand-off once |
| `delegate.maxHops`, `.deadlineSec` | 8, 1800 | longest chain; longest single run |
| `consent.timeoutSec` | 120 | how long a question waits before it is denied |
| `backend.concurrency` | 1 | requests a local model server runs at once |
| `gateway.port`, `gateway.routes` | 4141, none | see below |
| `connect.auto`, `connect.never` (Tools) | none | tools always / never connected |
| `scan.everyMin`, `observe.*`, `events.retentionDays` | 10, 3000/2000 ms, 14 | rescan and polling intervals; how long events are kept |
| `openclaw.model` | `auto` | OpenClaw's model: `auto`, `keep`, or `<server>:<model>` |

Targets take tasks through each tool's own standard: the model API (LM Studio, Ollama, …), ACP (OpenCode), its CLI (Claude Code, Cline, Codex, Hermes, Kilo, OpenClaw) or its chat (VS Code). The Kilo, Cline and Codex apps bundle a CLI; OpenCode's doesn't (`npm i -g opencode-ai`). **Tools** shows which tools can take tasks now.

## Choose the LLM per tool (model gateway)

Tools that accept a custom OpenAI-compatible endpoint (VS Code chat, OpenCode, Kilo, Cline) can use the gateway, so you pick each tool's LLM in one place, local or online (`auto` = the loaded model routing picks for what you asked).

- On by default at `http://127.0.0.1:4141/v1`, this machine only (`gateway.port`; `0` turns it off).
- **VS Code** is set up by itself when you connect it: an **Agent Spaghetti** model appears in its chat list and the **agent-spaghetti** agent uses it, so hand-offs need no Copilot credits. **Test gateway** in Tools → VS Code sends one short request. Load the local model with a context of at least 32768 tokens.
- **Other tools:** Tools → the tool → **Use the gateway** gives a key (shown once) and the exact steps.
- Tools → the tool → **Model**: `auto` or a specific one (`gateway.routes`).

A paid model asks first, like hand-offs. Every request is in **Runs**.

## Tested with

| Tool | Can be given tasks | Can hand tasks off | Status |
|---|---|---|---|
| LM Studio | yes (the model you loaded) | - | works; no web research through it |
| Ollama, llama.cpp server | yes (the model you loaded) | - | works (one local server is used at a time) |
| Claude Code (CLI) | yes | yes | works (offloads on its own) |
| Codex | yes | yes | works (paid: asks first) |
| Kilo | yes | yes | works, also web research |
| Cline | yes | yes | works, also web research |
| OpenCode | yes | yes | works, also web research |
| Hermes Agent | yes | yes | works; its profiles (its own agents, each with its model) can be picked per task kind; its main local model is slow to start |
| Cursor | - | yes | works (tested: a summary handed to Cline) |
| VS Code (Copilot chat) | yes | yes | in progress: see below |
| Claude Desktop | - | yes | not tested yet |
| MemPalace, Paperclip | found and shown; no tasks yet | - | - |

**VS Code status** (agent-spaghetti agent with the Agent Spaghetti model):

| What | Status |
|---|---|
| Set up by itself, model listed, gateway key accepted | works |
| Naming a tool (`kilo …`, `cline …`, `opencode …`) | reaches the tool |
| The tool gets your open folder and attached files | not yet: the tool may not find your files |
| A small local model deciding to hand off | unreliable: it sometimes answers itself or ignores the named tool |
| Chains (`kilo … then cline …`) and paid tools from VS Code | not yet |
| Next | Agent Spaghetti reads the message itself and hands it off (no local model in between), with your folder and files |

**Also to do:** Claude Desktop tests; a Metrics view (tokens saved on free tools, paid calls and their cost).

## Per-tool notes

- **OpenClaw:** Tools → OpenClaw → **Set up** installs its multi-step workflow pack (roles, settings, helpers; **Dry run** first if you like, **Check** any time). It needs a running OpenClaw gateway and `python3` on its host. The model it uses is the setting `openclaw.model`: `auto` (keep the current one while it answers, else the best loaded local model), `keep`, or `<server>:<model>` from `targets`.
- **Cursor:** cannot use a local model/endpoint as its own model (its servers can't reach your machine), so it works through hand-offs instead: the `/delegate` command, plain words, or the `>>` shortcut.
- **Hermes Agent:** its profiles show as its agents (`hermes -p <name>` with that profile's model, so nothing loads locally). Its own local model starts when a task needs it (the first answer can take a few minutes).
- **VS Code**'s inline completions stay with GitHub.

## License

[Business Source License 1.1](LICENSE): free for personal and internal use, not for selling or hosting as a service. Each version becomes Apache-2.0 2 years after its release.
