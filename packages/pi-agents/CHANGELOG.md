# @hank-warren/pi-agents

## 0.2.0

### Minor Changes

- Forked subagents, and worktrees in clones without `origin/HEAD`.

  - `Agent` takes `context: "fork"` to start the agent from a copy of the current conversation instead of an empty one; saved agents can make it their default with `context: fork`, and the call wins. The copy is the parent's branch from its latest compaction's kept range, in its original order, so Pi and compaction extensions such as `pi-codex-compaction` read it as they read the parent. Extension state, labels and model or thinking changes stay behind, and the tool call that started the agent is closed with a note that the parent carries on with it. The agent keeps its own model, thinking, tools and role, and its transcript in `/agents` starts at the fork.
  - A fork is refused before it starts when the conversation does not fit in 90% of the agent's model's window, or when the conversation was last compacted by an extension and the agent would run on a different model than the session.
  - `worktree` without `base` now asks origin for its default branch (`git ls-remote --symref origin HEAD`) when the clone has no `origin/HEAD`, instead of failing.

## 0.1.0

### Minor Changes

- Initial release. Claude Code-style subagents for Pi: each agent is its own `pi --mode rpc` process with your extensions, skills and `AGENTS.md`.

  - `Agent`, `SendMessage` and `TaskStop`, started from codemode scripts when codemode is active, with structured results for `Promise.all` fan-out. There are no built-in agents: the main session composes each one (model, thinking, tools, instructions, autocompact, turn budget, cwd, worktree), or starts from a saved agent in `~/.pi/agent/agents/*.md`.
  - Children know they are subagents, cannot start agents of their own, and enforce their tool allowlist on every call, including calls their codemode scripts make. Their permission prompts are shown in the parent, labeled with the agent's name.
  - `autocompact` compacts an agent at a percentage of its own model's context window, through Pi's compaction, so `pi-codex-compaction` still applies.
  - Instructions follow the agent: it inherits the session's instruction files and loads a directory's `AGENTS.md` the first time it works there. `worktree` creates an ordinary git worktree from the remote default branch and never removes it.
  - A one-line summary above the prompt, a drawer below it on `↓`, and a live view of each agent drawn with Pi's own components and the main session's tool renderers, where typing steers the agent. Reports render as Markdown.
  - Agents survive a restart: `/agents` lists them and `SendMessage` resumes them with the setup they ran with.
