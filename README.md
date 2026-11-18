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
  | Claude Code | `@`, pick the **agent-spaghetti** agent or a target (`@agent-spaghetti:target://lmstudio review this`) | `@` lists both |
  | Cursor | `/delegate lmstudio summarize README.md` | type `/` and pick **delegate**: the first word is the target (`auto` lets Agent Spaghetti choose), `>>next` adds a step |
  | Cursor, Claude Code | `>>lmstudio >>claude-cli review src/app.ts`, then Enter | the shortcut: sent straight to the targets, not to the tool's model; nothing pops up while typing |

  The open workspace goes along as the folder to work in, and attached files go too: agents get their paths (translated for WSL), models get their text. No target named? The tool asks you to pick one (or `auto`), and a paid target asks for approval right there or in the tray. Agents edit files only for editing kinds (code-edit, refactor, tests, docs). A `>>` result also lands in `<workspace>/.agent-spaghetti/results/<run>.md`.

  VS Code's chat runs on a *harness* you pick per session (Local, Copilot, Claude); what each offers differs, the table says which. After connecting, reload the tool once so it picks up the server, agent and hook.
- From the tray: **Runs → New task**. From a terminal: `delegate <target> <task> [--model <m>] [--then <target>,…]`.
- **Chains:** a hand-off can name next steps (`then`); each step gets the previous result, and the last result goes back to whoever asked: straight into the waiting call, into the caller's own session when it can continue one, into its chat (VS Code), or as a result waiting for it (`run_status`, the tray tells you).
- **Kind and difficulty:** a tool may say what sort of work a task is and how demanding (`kind`, `difficulty`); when it doesn't, Agent Spaghetti sets both from built-in rules (English and Italian) and shows them in Runs and Live, with how sure it is.
- **Saving paid usage automatically:** your connected tools hand some kinds of task to a free tool on their own, without you asking (by default summarize, research, docs, tests and review; change the list in **Routing**, or untick everything to hand off only when you ask). They keep small tasks, planning and decisions for themselves. Restart a tool after changing the list. The popover header shows how many tasks free tools did this week.
- **What a tool costs:** free tools run at once; paid ones, and ones Agent Spaghetti is not sure about, ask you first. If it gets a tool wrong (say, an agent you run on a local model), set **Cost** in that tool's row in **Tools**.
- **Grading:** a tool that got a poor result can say so (`run_status` with the run id and `grade: poor`), like Bad in Runs: later tasks of that kind go elsewhere.
- **`auto`** lets Agent Spaghetti pick the target for the task's kind and difficulty: free before paid, a target big enough for it (model size from its name; a free one a size smaller may try first), then how that target's past runs of that kind went (finished, failed, your Good/Bad/Redo). Research that brings no files of its own goes first to a tool that can search the web; planning goes to the strongest target, never to a small free one first; a tool that would have to load its own local model is not picked while another local model is loaded (name it yourself to do that), and a free agent that is busy with another task is passed over for the next one in line, even when you named it (paid ones can take several at once). Only one local model server is used at a time: LM Studio first, then a llama.cpp server, then Ollama (the first with a model loaded). If the target it chose fails or answers nothing, the next one tries, once per chain (a paid one asks first). **Routing** shows the order for each kind of task and why; there you can make a target **First** or **Never** for a kind and switch learning, stretching and escalation off. A dispatcher model (Settings → `dispatcher.model`, off by default) can pick among the ranked targets instead; with one set, a hand-off that stops progressing is passed to another target once.
- Targets take tasks through the standard each tool offers: the model API (LM Studio, Ollama, …), ACP (OpenCode), their own CLI (Claude Code, Cline, Codex, Hermes, Kilo, OpenClaw) or their chat (VS Code). ACP and CLI targets need the tool's CLI: the Kilo, Cline and Codex apps bundle one (Cline uses the provider and model set in Cline); the OpenCode app doesn't (`npm i -g opencode-ai`). Hermes with its own local model needs the Hermes app open (it runs that model's server). **Tools** shows which ones can take tasks now.
- **An agent's model:** a task can name one (`--model`); otherwise the agent uses its own default, or the one you set per agent in Settings → `delegate.models`: `<target>=<model>` (e.g. `kilo=kilo/kilo-auto/free`), or per task kind or difficulty `<target>:<kind or difficulty>=<model>` (e.g. `claude-cli:medium=sonnet`, `claude-cli:heavy=opus`, `hermes:research=researcher`). An agent that runs a model on this machine (Hermes with a local server) counts as free.
- **A tool's own agents** (e.g. Hermes profiles) are listed under the tool in **Tools → Its agents**. Ones with a free model (`:free`, `…/free`) are used; ones on a paid provider or with a local model of their own are off until you tick them (setting `agents.use`, `<tool>:<agent>=on|off`). A paid one asks first, like a paid tool. When a tool's own default would load its local model, one of its free agents takes the task instead.
- **Runs** shows each hand-off chain, where its result went and the result; rate it or cancel it there. **N waiting** lists results whose caller has not collected them yet (it asks with `run_status`); open one to read it or **Dismiss** it.
- **Flow** (Home): a live picture of your tools around Agent Spaghetti. A tool lights up while it works and says what it is doing and for whom ("researching for Claude"), with moving lines showing where the work goes. **Open bigger** shows it in its own window.
- In **Runs**, open a run to grade it (Good / Bad / Redo) or to correct what kind of task it was, so later tasks of that kind go to the right tool.
- **Live** (popover header, or tray menu → Live activity): a small window that stays on top while you work and shows each step as it happens, newest on top: who handed what to whom, Agent Spaghetti's choices, questions, the task as sent and the answer as it streams. Click a line to read it in full, `#n` to follow one run, **Stop #n** to end a run that hangs. Each run's question and answer are kept with its result in the data folder, so they show again after a restart.
- Third-party integrations (JSON files in the data folder's `integrations/`) do nothing until you allow each action (Tools → More).

## Choose the LLM per tool (model gateway)

Tools that accept a custom OpenAI-compatible endpoint (VS Code chat, OpenCode, Kilo, Cline) can use Agent Spaghetti's model gateway, so you pick each tool's LLM in one place, local or online (`auto` = the loaded model routing picks for what you asked).

- The gateway is on by default at `http://127.0.0.1:4141/v1` (Settings → `gateway.port`; `0` turns it off). It listens on this machine only.
- **VS Code** is set up by itself when you connect it: an **Agent Spaghetti** model appears in its chat model list, and the **agent-spaghetti** agent uses it, so handing work off from VS Code needs no Copilot credits. Tools → VS Code shows **gateway ready**; **Test gateway** sends one short request. The local model must have room for VS Code's requests: load it with a context of at least 32768 tokens.
- **Other tools:** Tools → the tool → **Use the gateway** gives a key, shown once, with the exact steps for that tool.
- Tools → the tool → **Model**: `auto` (the best free model loaded) or a specific one. Change it here any time; the tool needs no change.

Local models answer at once; a paid one (a hosted API added as your own integration) asks you first, as hand-offs do. Every request is in **Runs**, with what you asked and the answer kept in the data folder.

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
- **Hermes Agent:** its profiles show as its agents; a task given one runs as that profile (`hermes -p <name>`) with that profile's model, so nothing loads locally. Profiles on a free model are on by default; the rest you turn on in Tools. When it runs its own local model, Agent Spaghetti starts that model when a task needs it (the first answer can take a few minutes while it loads).
- **VS Code**'s inline completions stay with GitHub.

## License

[Business Source License 1.1](LICENSE): free for personal and internal use, not for selling or hosting as a service. Each version becomes Apache-2.0 2 years after its release.
