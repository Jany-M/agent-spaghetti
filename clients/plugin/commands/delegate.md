---
description: Hand the rest of this message to another model or agent (agent-spaghetti)
---

Call the agent-spaghetti `delegate` tool with `target` set to the first word the user typed after this command and `task` set to everything after that word, verbatim. Words written `>>next` right after the first word are next steps: pass them, in order, as `then` and leave them out of `task`. Pass the files the user attached or mentioned as `files`. Do nothing else; then show the tool's result as it is.
