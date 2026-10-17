---
name: delegate
description: Hand a task to a local model or another agent on this machine through the agent-spaghetti MCP tools. Use for bulk or mechanical work (tests, docs, summaries, refactors), second opinions, or when the user asks to use a specific local model or agent.
---

# Delegating with agent-spaghetti

1. Call `targets` to see what is available now. Each target has a cost class: `free` (local model, runs at once) `metered` (uses a paid plan) or `unknown` (the user is asked first for both).
2. Call `delegate` with:
   - `target`: a target id from `targets`; omit it to let the user pick (or `auto`);
   - `task`: the complete task, self-contained (the other model has none of this conversation);
   - `kind`: one of code-edit, tests, review, research, summarize, refactor, docs, other;
   - `reason`: one line saying why you hand it off;
   - `model`: optional, one of the target's models or agents listed by `targets`;
   - `cwd`: the project folder (default: your open workspace); agents edit there only for editing kinds;
   - `files`: the files the task is about (paths, absolute or relative to `cwd`); agents get the paths, models get the text;
   - `context`: optional findings or instructions the target needs besides the task;
   - `then`: optional next targets (`target` or `target:model`), in order; each gets the previous result, and the last result comes back to you;
   - `returnTo`: `none` when you need nothing back (default: the result comes back to you);
   - `returnSession`: your own session id if you know it, so a result that arrives after you stopped waiting can be resumed into it.
3. If `delegate` returns a run id instead of a result, call `run_status` with that id later. `run_status` without an id gives the results of your hand-offs that finished after you stopped waiting (each once).
4. A denied run means the user said no: do not retry it with another paid target unless the user asks.
5. A message starting with `>>target` (`>>a >>b task` for a chain) was already sent by the user's prompt hook; do not delegate it again.
6. A task that reached you from Agent Spaghetti with a `run_id` (in your chat) ends with `report`: call it with that `run_id` and your complete result.
