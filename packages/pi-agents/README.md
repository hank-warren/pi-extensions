# pi-agents

Subagents for [Pi](https://pi.dev) that look and feel like Pi. Each agent is its own `pi --mode rpc` process with your normal extensions, skills and `AGENTS.md`, configured with a markdown file. It renders with Pi's own tool rows, status line and transcript components, can be watched and steered while it runs, and optionally stays within a context budget.

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

## How it looks

The way of working comes from Claude Code's subagents: delegate, keep working, watch, steer. Everything is drawn with Pi's own pieces, so an agent looks like the rest of Pi rather than a port of another tool.

**The Agent call is an ordinary Pi tool row.** It uses the same tinted box, the same `toolTitle` call line and the same `... (N more lines, ctrl+o to expand)` collapse as `bash` or `read`. While a foreground agent works, the box lists its latest tool calls in Pi's own notation (`$ rg -n foo`, `read src/a.ts:10-40`, `grep /x/ in src`). When it finishes, the box shows the report and a `took 1m03s` footer.

```
 agent scout map payment flow
 ... (6 earlier tool calls, ctrl+o to expand)
 read src/pay.ts:1-40
 grep /refund/ in src
 $ rg -n "issueRefund" src

 claude-sonnet-5 · 41k/272k · 1m03s
```

**A background agent's report lands as a custom message** labeled `[agent]`, the same frame Pi gives `[skill]`:

```
 [agent] scout · done · 9 tool calls · 22k context · 31s
 Refunds are issued from src/refund.ts:12 …
 ... (8 more lines, ctrl+o to expand)
```

**The status line below the editor** uses the same shape as Pi's other status lines (`auto permissions · …`, `◆ plan · …`). It appears whenever agents are running or have just finished:

```
 agents · 2 running · 1 waiting for you                                          ↓ to manage
   ⠹ reviewer review auth changes        claude-opus-5 · 41k/1M · 18 tool calls · 2m10s
   ? pusher   push release branch        waiting for your approval · gpt-5.6-luna · 3k/272k · 2 tool calls · 40s
   ✓ scout    map payment flow           claude-sonnet-5 · 22k/120k budget · 9 tool calls · 31s
```

| Key | Action |
|---|---|
| `↓` (at an empty prompt) | Focus the list; `→` marks the selection, as in Pi's selectors |
| `↑` / `↓` | Move between rows |
| `Enter` | Open the agent |
| `x` | Stop a running agent, or dismiss a finished row |
| `Esc` | Back to the prompt |

**Opening an agent shows its session as Pi would.** The view takes the editor's place, like `/tree` or `/resume`. Inside it, user messages, assistant markdown and tool boxes are drawn with Pi's own components and built-in tool renderers, so `$ bash` output, `read` previews and `edit` diffs look the same as in the main session. Assistant text streams in live.

| Key | Action |
|---|---|
| Type, then `Enter` | Steer a running agent (delivered after its current tool calls), or follow up on a finished one |
| `↑` `↓` `PgUp` `PgDn` | Scroll |
| `Ctrl+O` | Expand or collapse every tool box |
| `Ctrl+X` | Stop the agent |
| `Esc` | Back |

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
