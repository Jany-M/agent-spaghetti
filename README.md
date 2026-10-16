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

## Coming next

A desktop app and tray icon to see, connect and test your AI tools and models in one place, and to pick which LLM does which job.

## License

[Business Source License 1.1](LICENSE): free for personal and internal use, not for selling or hosting as a service. Each version becomes Apache-2.0 on 2029-10-16 or four years after its release, whichever comes first.
