# pi-agents

Claude Code-style subagents for [Pi](https://pi.dev). Each agent is its own `pi --mode rpc` process with your normal extensions, skills and `AGENTS.md`. Agents are configured with markdown files, show up in a live panel below the editor, can be steered while they run, and stay within a context and turn budget.

```bash
pi install npm:@hank-warren/pi-agents
```

## Why a process per agent

Each agent runs as a separate Pi process. The main thing that buys is a **responsive parent**: a child's tool output, streaming and compaction run on its own CPU, so the parent's TUI is never blocked by them. It also gives you:

- **Extensions that behave normally.** A child is an ordinary Pi session, so there is no shared-process state for extensions to trip over.
- **A clean stop.** Stopping an agent ends its process.
- **Permission prompts from the right place.** A child's dialogs (Auto Permissions approvals, mostly) are forwarded over RPC and shown in the parent, labeled with the agent's name.

The cost is a cold start of a second or more per spawn, depending on how many extensions you load. A finished agent keeps its process for `idleTtlSeconds`, so follow-ups to it skip the cold start.

Children are spawned with the parent's own Pi binary and Node, plus any `-e` extensions the parent was started with.

## Tools

| Tool | What it does |
|---|---|
| `Agent` | Start an agent: `subagent_type`, `description`, `prompt`, plus optional `name`, `model`, `thinking`, `run_in_background` (default true), `cwd`, `worktree`. |
| `SendMessage` | Message an agent by name or id. A running agent gets it as steering after its current tool calls; a finished agent resumes with it as a follow-up and keeps its history. `wait: true` blocks for the result. |
| `TaskStop` | Stop an agent. |

**Background agents** return at once. Their result arrives later as a message that wakes the model.

**Foreground agents** (`run_in_background: false`) block and return the result. Several foreground calls in one message run in parallel.

### Orchestrating with codemode

`Agent` declares an output schema, so a codemode script gets a structured value back instead of text: `{ id, name, status, result, toolUses, contextTokens, durationMs, sessionFile, worktreePath, branch }`. That makes deterministic fan-out a plain script, with no separate workflow engine:

```js
const areas = ["auth", "billing", "search"];
const reports = await Promise.allSettled(areas.map((area) =>
  tools.Agent({ subagent_type: "scout", description: `map ${area}`, prompt: `Map the ${area} flow…`, run_in_background: false })));
return reports.map((r, i) => r.status === "fulfilled" ? `## ${areas[i]}\n${r.value.result}` : `## ${areas[i]}\nfailed: ${r.reason}`).join("\n\n");
```

Only the script's output reaches the parent's context. Pressing Esc, or a script that ends early, stops the agents it started.

## The panel

The panel appears below the editor whenever agents are running or have just finished:

```
  2 agents running · ↓ to manage
    ⠹ reviewer  Review auth changes        claude-opus-5 · ctx 41k/1M · 18 tools · 2m10s
    ✓ scout     Map payment flow           claude-sonnet-5 · ctx 22k/120k budget · 9 tools · 31s
```

| Key | Action |
|---|---|
| `↓` (at an empty prompt) | Focus the list |
| `↑` / `↓` | Move between rows |
| `Enter` | Open the agent's live transcript |
| `x` | Stop a running agent, or dismiss a finished row |
| `Esc` | Back to the prompt |

In the transcript view:

| Key | Action |
|---|---|
| Type, then `Enter` | Steer a running agent, or follow up on a finished one |
| `↑` `↓` `PgUp` `PgDn` | Scroll |
| `Ctrl+X` | Stop the agent |
| `Esc` | Close |

`/agents` lists every agent in the session, including ones restored after a restart, and opens one. `/agents types` lists the agent definitions and any errors in them.

## Agent files

Agent files are markdown with YAML frontmatter. The body is appended to the child's normal Pi system prompt, so tool guidance, skills and `AGENTS.md` all stay.

| Location | Scope |
|---|---|
| `~/.pi/agent/agents/**/*.md` | Every project |
| `.pi/agents/**/*.md` in the cwd and every directory above it | That project; the closest directory wins. Loaded only when the project is trusted. |

Agents defined here replace the built-ins (`general-purpose`, `scout`) by name.

```markdown
---
name: reviewer
description: Fresh-context review of a diff or branch. Use after non-trivial changes.
model: cpa/claude-opus-5
thinking: high
tools: read, bash, grep, find, ls, codemode
maxTurns: 40
contextBudget: 150000
---
Review the change you are given for correctness bugs first, then risky edge cases.
Report findings as file:line, severity, and why. No style nits.
```

| Field | Meaning |
|---|---|
| `name`, `description` | Required. The description is what the parent model uses to choose the agent. Files without a `name` are skipped as documentation. |
| `tools` | Allowlist, as a comma string or YAML list. Omit it to give the agent every tool its extensions provide. |
| `disallowedTools` | Removed from whatever the agent would otherwise get. |
| `model` | `provider/id`. Omit it, or write `inherit`, to use the parent's current model. An unknown model is an error, never a silent fallback. |
| `thinking` (or `effort`) | `off` … `max`. Default: the parent's current level. |
| `maxTurns`, `contextBudget` | Turn budget (default 80) and an optional context budget. See the next section. |
| `background` | Default for `run_in_background`. |
| `contextFiles: false` | Skip `AGENTS.md` / `CLAUDE.md`. |

## Budgets: agents that stop on time

Every child enforces its budget from inside its own process:

- **At 75% of `contextBudget` or 80% of `maxTurns`**, the agent is steered: stop exploring, finish what is essential, and report.
- **At 100%**, every further tool call is refused and the agent must write its final report. If it keeps calling tools, the run is aborted.

The result says `budget exhausted` when this happened.

`maxTurns` defaults to 80. **There is no context budget by default**: an agent can use its model's whole window, and Pi's compaction applies as in any session. Set `contextBudget` on an agent that should stop well short of its window. This matters most for long-context models, which tend to keep reading until their answers degrade. The panel shows `ctx 78k/150k budget` for an agent with a budget, and `ctx 78k/272k` against the model's window for one without.

## Worktrees for multi-repo workspaces

Pass `worktree: { repo, branch, base? }` and the agent runs in a git worktree created from `origin/<base>`, which defaults to origin's default branch. The worktree is placed at `<worktreeDir>/<branch with slashes as dashes>`. If a worktree for that branch already exists there, it is reused.

`worktreeDir` defaults to a `worktrees/` directory beside the repository, so `~/repos/foo` gets `~/repos/worktrees/feat-x`.

This works from a directory that is not itself a repository, such as a folder of repositories. `repo` is resolved against the session directory.

Worktrees are never removed automatically. The agent is told not to commit or push unless its task says so.

For read-only work in one repository of such a workspace, use `cwd` instead. That repository's `AGENTS.md` is loaded.

## Subagent awareness

A child knows it is a subagent:

- Its system prompt says so.
- It has no `Agent`, `SendMessage` or `TaskStop` tools, so it cannot recurse.
- It never gets `ask_user_question` or the goal tools.

Children are started with `PI_SUBAGENT_CHILD=1`, `PI_SUBAGENT_RUN_ID` and `PI_SUBAGENT_DEPTH=1`. [`@hank-warren/pi-auto-permissions`](../pi-auto-permissions) reads these and makes a child revise a command before a human is interrupted. `HERDR_PANE_ID` is removed from a child's environment, so a child never drives the parent pane's state.

## Configuration

Settings live in `~/.pi/agent/pi-agents/config.json` (override the path with `PI_AGENTS_CONFIG`):

```json
{
  "maxConcurrent": 6,
  "maxTurns": 80,
  "idleTtlSeconds": 600,
  "worktreeDir": "~/repos/worktrees",
  "excludeTools": ["web_search"],
  "piCommand": ["pi"]
}
```

| Key | Meaning |
|---|---|
| `maxConcurrent` | Number of children running at once. Further spawns queue. |
| `contextBudget` | A context budget for every agent that does not set its own. Unset by default. |
| `idleTtlSeconds` | How long a finished child's process is kept for follow-ups. |
| `excludeTools` | Added to the built-in exclusions: subagent tools, `ask_user_question`, and the goal tools. |
| `piCommand` | Overrides how a child is started. |

## Sessions

Child sessions are written to `<parent session dir>/<parent session>/agents/`. A finished agent is recorded in the parent session, so after a restart `/agents` still lists it, its transcript loads from the child's session file, and `SendMessage` resumes it from there.
