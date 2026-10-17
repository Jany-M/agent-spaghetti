---
name: delegate
description: Hand a task to a local model or another agent on this machine through the agent-spaghetti MCP tools. Use for bulk or mechanical work (tests, docs, summaries, refactors), second opinions, or when the user asks to use a specific local model or agent.
---

# Delegating with agent-spaghetti

1. Call `targets` to see what is available now. Each target has a cost class: `free` (local model, runs at once) `metered` (uses a paid plan) or `unknown` (the user is asked first for both).
2. Call `delegate` with:
   - `target`: a target id from `targets`;
   - `task`: the complete task, self-contained (the other model has none of this conversation);
   - `kind`: one of code-edit, tests, review, research, summarize, refactor, docs, other;
   - `reason`: one line saying why you hand it off;
   - `model`: optional, one of the target's models or agents listed by `targets`;
   - `cwd`: the project folder, only when the target is an agent that should edit files there;
   - `context`: optional findings or instructions the target needs besides the task;
   - `then`: optional next targets (`target` or `target:model`), in order; each gets the previous result, and the last result comes back to you;
   - `returnTo`: `none` when you need nothing back (default: the result comes back to you);
   - `returnSession`: your own session id if you know it, so a result that arrives after you stopped waiting can be resumed into it.
3. If `delegate` returns a run id instead of a result, call `run_status` with that id later. `run_status` without an id gives the results of your hand-offs that finished after you stopped waiting (each once).
4. A denied run means the user said no: do not retry it with another paid target unless the user asks.
