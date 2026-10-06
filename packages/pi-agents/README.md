# pi-agents

Subagents for [Pi](https://pi.dev) that look and feel like Pi. Each agent is its own `pi --mode rpc` process with your normal extensions, skills and `AGENTS.md`. The main session composes each agent for its task (model, thinking, tools, role), starts it from a codemode script, and can watch and steer it while it runs. Agents you want to reuse are saved as markdown files.

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
| `Agent` | Start an agent: `description`, `prompt`, plus optional `instructions` (its role), `agent` (a saved agent to start from), `name`, `model`, `thinking`, `tools`, `autocompact`, `max_turns`, `run_in_background` (default true), `cwd`, `worktree`. |
| `SendMessage` | Message an agent by name or id. A running agent gets it as steering after its current tool calls; a finished agent resumes with it as a follow-up and keeps its history. `wait: true` blocks for the result. |
| `TaskStop` | Stop an agent. |

**There are no built-in agents.** The main session decides what each task needs: `cpa/claude-opus-5-5` with high thinking for a review, a fast model with `tools: ["read", "bash", "codemode"]` for a lookup, a role in `instructions`. Anything it leaves out comes from the session: its model, its thinking level, every tool your extensions provide. An agent you want again goes in a [saved agent file](#saved-agents).

**Background agents** return at once. Their result arrives later as a message that wakes the model.

**Foreground agents** (`run_in_background: false`) block and return the result.

### Started from codemode

When the session has `codemode`, the three tools are registered with Pi's `codemode` exposure: they are not declared to the model as tools of their own, and the model starts agents from scripts. Without codemode they are ordinary tools.

`Agent` declares an output schema, so a script gets a structured value back: `{ id, name, type, status, result, toolUses, contextTokens, durationMs, sessionFile, worktreePath, branch }`. Fan-out is a plain script:

```js
const lanes = [
  { model: "cpa/claude-opus-5-5", name: "opus-review" },
  { model: "cpa/gpt-6.1-sol", name: "sol-review" },
];
const reviews = await Promise.allSettled(lanes.map((lane) => tools.Agent({
  ...lane,
  description: "review PR 55",
  instructions: "You review diffs for correctness bugs. Report file:line, severity, why, and the smallest fix.",
  prompt: "Review `gh pr diff 55` in ~/repos/worktrees/pi-agents …",
  thinking: "high",
  autocompact: 10,
  run_in_background: false,
})));
return reviews.map((r, i) => `## ${lanes[i].name}\n${r.status === "fulfilled" ? r.value.result : `failed: ${r.reason}`}`).join("\n\n");
```

Only the script's output reaches the parent's context. Pressing Esc, or a script that ends early, stops the agents it started. Children have codemode too, but no agent tools: an agent never starts another.

## How it looks

The way of working comes from Claude Code's subagents: delegate, keep working, watch, steer. Everything is drawn with Pi's own pieces, so an agent looks like the rest of Pi rather than a port of another tool.

**Without codemode, the Agent call is an ordinary Pi tool row.** It uses the same tinted box, the same `toolTitle` call line and the same `... (N more lines, ctrl+o to expand)` collapse as `bash` or `read`. While a foreground agent works, the box lists its latest tool calls in Pi's own notation (`$ rg -n foo`, `read src/a.ts:10-40`, `grep /x/ in src`). When it finishes, the box shows the report and a `took 1m03s` footer. Started from codemode, the script's own row shows the call, and the agent list below shows its progress.

```
 agent map payment flow · claude-sonnet-5-5
 ... (6 earlier tool calls, ctrl+o to expand)
 read src/pay.ts:1-40
 grep /refund/ in src
 $ rg -n "issueRefund" src

 claude-sonnet-5-5 · 41k/1M · 1m03s
```

**A background agent's report lands as a custom message**, in the frame Pi gives injected text, rendered as Markdown. Until `ctrl+o` it shows up to eight lines and never cuts a paragraph or table in half:

```
 agent ✓ map-payment-flow · 9 tool calls · 22k context · 31s

 Refunds are issued from src/refund.ts:12.

 ... (14 more lines, ctrl+o to expand)
```

**Above the prompt, one line sums up the agents** while a batch runs and for a minute after the last one finishes. A batch is every agent started while another was still running.

```
 ⠹ Agents | 1/3 completed | 1 needs you | ↓ to manage
```

**`↓` at an empty prompt opens them below the prompt.** It is a drawer that is only there while you use it: a row per agent with its state, name, task, model, context and elapsed time, and under each running agent the tool call it is running right now. The cursor starts on an agent waiting for your approval, if there is one.

```
→ ⠹ auth-review  review auth changes   claude-opus-5-5 · 41k/100k autocompact · 2m10s
                 $ git diff origin/main...HEAD
  ? pusher       push release branch   needs you · gpt-5.6-luna · 3k/272k · 40s
                 waiting for your approval: git push origin release
  ✓ scout        map payment flow      claude-sonnet-5-5 · 22k/1M · 31s
  ↑↓ select · enter open · x stop · esc back
──────────────────────────────────────────────────────────────────────────
```

| Key | Action |
|---|---|
| `↓` (at an empty prompt) | Open the drawer |
| `↑` / `↓` | Move between agents; `↑` off the top closes the drawer, and only the next `↑` recalls a previous prompt |
| `Enter` | Open the agent |
| `x` | Stop a running agent, or dismiss a finished one |
| `Esc` | Close the drawer |
| Anything else | Closes the drawer and goes to the editor, so you can just start typing |

**Opening an agent shows its session as Pi would.** The view takes the editor's place, like `/tree` or `/resume`, and follows the agent live, the way Pi's interactive mode follows its own session:

- User messages, assistant Markdown, thinking, tool boxes and compaction summaries are drawn with Pi's own components.
- Thinking and text stream in. A tool call appears while its arguments are still streaming, and its output updates in place, with Pi's `Working...` line underneath.
- Each tool is drawn with the renderer the main session uses for it, so a codemode row shows the calls its script made, and an extension's tool looks the same as it does in your session. That renderer is known once the main session has shown the tool at least once since its last reload; until then Pi's built-in renderer (`$ bash` output, `read` previews, `edit` diffs) or its generic one is used.
- Thinking is shown or hidden as your `hideThinkingBlock` setting says, and your output padding, image and code-block settings apply.

| Key | Action |
|---|---|
| Type, then `Enter` | Steer a running agent (delivered after its current tool calls), or follow up on a finished one |
| `↑` `↓` `PgUp` `PgDn` | Scroll |
| Pi's expand key (`Ctrl+O`) | Expand or collapse every tool box |
| Pi's thinking key (`Ctrl+T`) | Show or hide thinking in this view, without changing your setting |
| `Esc` | Back to the drawer, on this agent: `x` stops it, `Enter` reopens it, `↑` past the top or typing returns to the prompt |

`/agents` lists every agent in the session, including ones restored after a restart, and opens one. `/agents types` lists the saved agents and any errors in their files.

## Saved agents

An agent you want to reuse is a markdown file with YAML frontmatter in `~/.pi/agent/agents/` (under `PI_CODING_AGENT_DIR` when set; subdirectories are fine). The main session sees each one's name and description, starts from it with `agent: "<name>"`, and can override any field in the call. The body is the agent's role, appended to the child's normal Pi system prompt, so tool guidance, skills and `AGENTS.md` all stay.

```markdown
---
name: reviewer
description: Fresh-context review of a diff or branch. Use after non-trivial changes.
model: cpa/claude-opus-5-5
thinking: high
tools: read, bash, grep, find, ls, codemode
autocompact: 10
---
Review the change you are given for correctness bugs first, then risky edge cases.
Report findings as file:line, severity, and why. No style nits.
```

| Field | Meaning |
|---|---|
| `name`, `description` | Required. The description is what the parent model uses to choose the agent. Files without a `name` are skipped as documentation. |
| `tools` | Allowlist, as a comma string or YAML list; `*` matches any characters. Omit it to give the agent every tool its extensions provide. The child refuses every other call, including calls a codemode script makes, so an MCP or codemode-only tool the list does not name is out of reach too. |
| `disallowedTools` | Removed from whatever the agent would otherwise get. |
| `model` | `provider/id`. Omit it, or write `inherit`, to use the parent's current model. An unknown model is an error, never a silent fallback. |
| `thinking` (or `effort`) | `off` … `max`. Default: the parent's current level. |
| `autocompact` | Compact at this percentage of the model's context window. See the next section. |
| `maxTurns` | Turn budget per task (default 80). |
| `background` | Default for `run_in_background`. |
| `contextFiles: false` | Skip `AGENTS.md` / `CLAUDE.md`. |

## Context: the full window, or autocompact

**By default an agent gets its model's full context window**, 1M on most Claude models and 272k on most GPT models, and Pi compacts it near the end of that window as in any session.

**`autocompact` compacts it earlier**, at a percentage of its own model's window. Ask two reviewers for `autocompact: 10` and the `claude-opus-5-5` one compacts at 100k while the `gpt-6.1-sol` one compacts at 27.2k. Set it per call, per saved agent, or for every agent in the config.

Compaction is Pi's own, so compaction extensions apply inside agents too: `pi-codex-compaction` still gives GPT models native compaction. Pi has no per-session threshold, so the child stops before its next model request, compacts once the run settles, and the parent continues the task with `Compaction completed. Continue.` If the child refuses that prompt, the run fails with the reason instead of hanging. After a compaction it waits for the context to grow by half the threshold before compacting again, so a context that cannot shrink below the threshold does not compact every turn. Pi only summarizes history older than its `compaction.keepRecentTokens` (20k by default), so a threshold below that has nothing to compact at first; autocompact then tries again once the context has grown by half the threshold. If compaction fails for any other reason, Pi's own threshold takes over for the rest of that agent's session. The list shows `41k/100k autocompact` for such an agent and `41k/1M` for one without.

**Turns are budgeted.** At 80% of `maxTurns` the agent is told to stop exploring and finish; at 100% every further tool call is refused and it must write its final report. If it keeps calling tools, the run is aborted, and the result says `turn budget exhausted`.

## Where agents work

An agent starts in the session's directory, or in `cwd` for one repository of a multi-repo workspace such as `~/repos/workbench`. Its bash calls start there, but it works wherever the task takes it, with absolute paths, `cd <dir> && …` and `git -C <dir>`.

**Instructions follow it:**

- It loads its own directory's `AGENTS.md` / `CLAUDE.md` chain, as Pi always does.
- It also gets the instruction files of the session that started it, so a worktree outside the workspace still follows the workspace's `AGENTS.md`. They go in its system prompt after the files both share and before its own directory's.
- The first time it works in another directory, through a file tool's `path` or bash `cd`, `pushd`, `git -C` or an absolute path, that directory's chain of instruction files it does not have yet is added to the tool result. A codemode script's calls attach them to the script's result. Files loaded this way stay in its system prompt for later prompts, and are loaded again after a compaction.

**Worktrees.** Pass `worktree: { repo, branch, base? }` and the agent runs in a git worktree created from `origin/<base>`, which defaults to origin's default branch. It is placed at `<worktreeDir>/<branch with slashes as dashes>`, and reused if it already exists there. `worktreeDir` defaults to a `worktrees/` directory beside the repository, so `~/repos/foo` gets `~/repos/worktrees/feat-x`. `repo` is resolved against the session directory, so this works from a directory of repositories.

An agent can also make its own worktrees when its task needs changes in a repository it reaches on the way. Its prompt names the same `worktreeDir` and layout, tells it to create them from the remote default branch and reuse existing ones, and never to edit a main checkout.

Worktrees are never removed automatically. An agent is told not to commit, push or open pull requests unless its task says so.

## Subagent awareness

A child knows it is a subagent:

- Its system prompt says so.
- It has no `Agent`, `SendMessage` or `TaskStop` tools, in codemode or otherwise, so it cannot recurse.
- It never gets `ask_user_question` or the goal tools.

Children are started with `PI_SUBAGENT_CHILD=1`, `PI_SUBAGENT_RUN_ID` and `PI_SUBAGENT_DEPTH=1`. [`@hank-warren/pi-auto-permissions`](../pi-auto-permissions) reads these and makes a child revise a command before a human is interrupted. `HERDR_PANE_ID` is removed from a child's environment, so a child never drives the parent pane's state.

## Configuration

Settings live in `~/.pi/agent/pi-agents/config.json` (override the path with `PI_AGENTS_CONFIG`):

```json
{
  "maxConcurrent": 6,
  "maxTurns": 80,
  "autocompact": 15,
  "idleTtlSeconds": 600,
  "worktreeDir": "~/repos/worktrees",
  "excludeTools": ["web_search"],
  "piCommand": ["pi"]
}
```

| Key | Meaning |
|---|---|
| `maxConcurrent` | Number of children running at once. Further spawns queue. |
| `autocompact` | Autocompact percentage for every agent that does not set its own. Unset by default: agents get their full window. |
| `maxTurns` | Turn budget for every agent that does not set its own. |
| `worktreeDir` | Where worktrees go, for `worktree` requests and for agents that make their own. |
| `idleTtlSeconds` | How long a finished child's process is kept for follow-ups. |
| `excludeTools` | Added to the built-in exclusions: subagent tools, `ask_user_question`, and the goal tools. |
| `piCommand` | Overrides how a child is started. |

## Sessions

Child sessions are written to `<parent session dir>/<parent session>/agents/`. A finished agent is recorded in the parent session, so after a restart `/agents` still lists it, its transcript loads from the child's session file, and `SendMessage` resumes it from there.
