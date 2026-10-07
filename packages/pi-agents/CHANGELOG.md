# @hank-warren/pi-agents

## 0.1.0

### Minor Changes

- Initial release. Claude Code-style subagents for Pi: each agent is its own `pi --mode rpc` process with your extensions, skills and `AGENTS.md`.

  - `Agent`, `SendMessage` and `TaskStop`, started from codemode scripts when codemode is active, with structured results for `Promise.all` fan-out. There are no built-in agents: the main session composes each one (model, thinking, tools, instructions, autocompact, turn budget, cwd, worktree), or starts from a saved agent in `~/.pi/agent/agents/*.md`.
  - Children know they are subagents, cannot start agents of their own, and enforce their tool allowlist on every call, including calls their codemode scripts make. Their permission prompts are shown in the parent, labeled with the agent's name.
  - `autocompact` compacts an agent at a percentage of its own model's context window, through Pi's compaction, so `pi-codex-compaction` still applies.
  - Instructions follow the agent: it inherits the session's instruction files and loads a directory's `AGENTS.md` the first time it works there. `worktree` creates an ordinary git worktree from the remote default branch and never removes it.
  - A one-line summary above the prompt, a drawer below it on `↓`, and a live view of each agent drawn with Pi's own components and the main session's tool renderers, where typing steers the agent. Reports render as Markdown.
  - Agents survive a restart: `/agents` lists them and `SendMessage` resumes them with the setup they ran with.
