# @hank-warren/pi-claude

Claude models in Pi that draw only on your Claude subscription's plan limits.
Every request goes through your own, unmodified Claude Code (`claude -p`),
signed in by you with `claude auth login`. No API keys, no usage credits, no
proxy that touches your credentials.

Fork of [earendil-works/pi-claude-code](https://github.com/earendil-works/pi-claude-code)
(MIT). This fork replaces its per-turn relay with one long-lived Claude Code
process per Pi session:

- **Message threads.** Claude Code's own threads client is switched on, so after
  the first request each turn sends only the new messages.
- **Real tool results.** Pi's tools are offered to Claude through a small MCP
  bridge. When Claude calls one, the Pi turn ends, Claude Code waits inside the
  MCP call, and Pi's actual result answers it. Claude Code's history holds the
  same tool results as Pi's.
- **Branches stay warm.** `/tree` navigation, edits, regenerations, model or
  thinking-level changes fork Claude Code's stored session at the last shared
  message instead of replaying the conversation, so the prompt cache still hits.
- **Accurate context windows.** Each model's context window is the one Claude
  Code applies to your account, read from Claude Code itself.

## Requirements

- Pi
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on your `PATH`,
  logged in with a Claude Pro or Max subscription: `claude auth login`.

## Install

```sh
pi install npm:@hank-warren/pi-claude
```

Then pick a model from the **Claude (subscription)** provider, for example
`/model claude-sub/claude-opus-5-5`.

## Commands

- `/claude-sub-status`: Claude Code version, login and plan, whether message
  threads are on, live Claude Code processes, and the last few turns with how
  each reached Claude Code (`fresh`, `continue`, `tool-results`, `fork`,
  `synth`), its time to first token, and token usage.

## Usage and billing

Requests count against your Claude subscription's limits, like any other Claude
Code use. If Claude Code reports that a response was charged to usage credits
(extra usage), the turn fails with a non-retryable billing error; there is no
override. Turn off usage credits at claude.ai/settings/usage to stay on plan
limits.

The extension refuses to start Claude Code when the environment sets
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, a Foundry key,
Bedrock/Vertex base URLs, or `CLAUDE_CODE_USE_BEDROCK`/`VERTEX`/`FOUNDRY`.
It never reads, copies or stores Claude Code's credentials.

Fast mode is not offered: it needs usage credits.

## Configuration

Optional environment variables:

- `PI_CLAUDE_SUB_COMMAND`: Claude Code executable (default `claude`).
- `PI_CLAUDE_SUB_CONFIG_DIR`: passed to Claude Code as `CLAUDE_CONFIG_DIR`.
- `PI_CLAUDE_SUB_THREADS=0`: turn message threads off.

## Claude Code sessions

Claude Code stores each conversation under
`~/.claude/projects/<project>/<session>.jsonl`, in the same project directory as
your own Claude Code sessions for that folder, so they can show up in
`claude --resume`. The extension records the sessions it creates and deletes
them seven days after their last use. Pi remains the source of truth for the
conversation; a deleted session only means the next turn rebuilds it.

## Limitations

- When Pi's history contains turns Claude Code never produced (another provider,
  compaction, a session from before this extension was installed), the
  extension writes a Claude Code transcript for them. The first request after
  that is a full, uncached replay.
- A message you send while tools are running is delivered with the tool results
  by forking at the tool call, not through the waiting process.
- Changing the system prompt, tools, model or thinking level forks a new Claude
  Code process. The prompt cache usually still hits; the message thread starts
  over.
- Claude Code adds its own context to the conversation (its Agent SDK identity
  line, the working directory and platform, the date, your account email).

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it works.
