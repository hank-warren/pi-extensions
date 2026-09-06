---
name: pi-orchestrator
description: Supervise first-class pi sessions running in Herdr panes — launch children, read their state without bloating context, detect and answer Auto Permissions prompts within policy, steer, wait with the process tool, verify results. Use for /pi-orchestrator, or when asked to orchestrate, supervise, or run several pi agents in Herdr. Requires HERDR_ENV=1 and the herdr CLI.
---

# pi-orchestrator

You are the supervisor. The children are real pi sessions in Herdr panes, with the full extension set a human's session has — Auto Permissions, Plan Mode, the statusline, the Herdr integration — and a human can click into any of them at any time. Nothing here is a subagent. Your job is the part no pacemaker could do: decide what each child works on, notice when one is waiting on a person, answer for the person within a bounded policy, steer when it drifts, and check its claims before you repeat them.

Command syntax belongs to the `herdr` CLI itself — `herdr --help`, then `herdr agent` and `herdr pane` for each group — and to a `herdr` skill if your host ships one. This file is only the doctrine of supervising pi with it.

## Preconditions

```bash
test "${HERDR_ENV:-}" = 1 || echo "not inside herdr"
```

If that fails, say you are not running inside Herdr and stop. Otherwise learn the installed CLI before the first command — `herdr --help`, then `herdr agent`, `herdr pane` and `herdr tab` printed without a subcommand list each group — and confirm `herdr agent` lists `pi` among the kinds. If a `herdr` skill is available in this session, read it in full; it is the authority on IDs, read sources and focus rules, and this file assumes them. In brief: public IDs are opaque (`w1`, `w1:t1`, `w1:p1`) and come from JSON responses, never guessed; `$HERDR_WORKSPACE_ID`, `$HERDR_TAB_ID` and `$HERDR_PANE_ID` name where you are; read sources are `visible` (the rendered viewport), `recent-unwrapped` (transcript with soft wraps joined) and `detection` (the plain-text bottom buffer); and `ctrl+c` clears a pi composer where `ctrl+d` exits it.

Start a notes file **before** launching anything:

```bash
NOTES=/tmp/orchestrator-$(printf '%s' "$PI_SESSION_ID" | cut -c1-8).md
```

Every child, its pane and tab IDs, its worktree and branch, every approval or block you make, and every verdict goes in this file as it happens. Compaction will take these out of your context; the file is what you re-read afterwards. After any compaction, re-read the notes file and run `herdr agent list` to reconcile what is actually alive with what you recorded.

## Topology

One Herdr workspace per orchestration, and it is the one you are in: `$HERDR_WORKSPACE_ID`. **Never create a workspace.** Children live in tabs of that workspace, or in splits beside you when there are at most two and the user wants them on screen. Split a wide pane to the right and a tall one down (`herdr pane layout --current` tells you which); a third same-direction split is unusable.

```bash
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <dir> --label <name> --no-focus
# -> .result.tab.tab_id, .result.root_pane.pane_id
herdr agent start <name> --kind pi --pane <root-pane-id> -- <pi args>
```

Every create takes `--no-focus`; the user is driving another pane. Close only what this run created, and only after the user has seen the result or asked for cleanup. Do not touch panes or tabs that were there when you started.

A child that changes a repository works in its own worktree, made by you before launch so the child's cwd is already the worktree: `git fetch origin && git worktree add <dir> -b <branch> origin/<default-branch>`, branching from the remote ref so the child starts from what is actually on the default branch. Follow the host's own conventions for where worktrees live if it has them; otherwise a sibling directory of the clone. Pass that directory as `--cwd` on the tab. Two children never share a worktree, and no child works in the clone itself.

## Launching a child

Name it: `[a-z][a-z0-9_-]{0,31}`, unique among live agents, descriptive of the task (`stash-readme`, `review-pr-6`), never `agent1`. Pick a model only when the task warrants it (`-- --model provider/id`); otherwise the host default.

Brief the child **through its first prompt**, not through `--append-system-prompt`. A prompt lands in the child's transcript and survives its compaction; a system append is invisible to a human who attaches, and to you when you read the session file later.

```bash
herdr agent prompt <name> "$(cat <<'EOF'
<brief>
EOF
)" --wait --timeout 600000
```

The brief has four parts, always in this order.

**The objective, written as an acceptance test.** One requirement per bullet, and the check named in the bullet. A conjunction inside a sentence does not split: "fix the flaky test and update the docs" is one requirement whose evidence must cover both halves, and nothing will remind the child of the second half. When you cannot name the check, say what you will inspect instead. Two questions fix most objectives: how will we know it is done, and what command proves it?

| Said | Drafted |
| --- | --- |
| make the tests better | raise `packages/foo` line coverage above 80%, proven by `npm run coverage` |
| fix the login bug | `npm test -- auth` passes five consecutive runs, and the reproduction in issue #12 no longer reproduces |
| write the docs | `docs/setup.md` exists, covers install, config and first run, and every relative link resolves (`scripts/validate.py` clean) |

Draft from what the user said, never a tidier version of it. If they declined to name checks, tell them what you will and will not be able to verify before you launch.

**Ground rules.** Hard constraints the child must never violate while you are not watching: systems that are off limits, things never to push or delete, files it may not edit to make a check pass. Write them down, because you enforce them at approval time (below) and a rule you did not state is a rule you cannot hold the child to.

**Where.** The worktree path and branch, and the default branch it came from.

**The supervision line, verbatim:**

> You are supervised by an orchestrator session. When you would ask the user a question, ask it — the supervisor answers. When you finish, state each requirement and the evidence for it, then stop.

Use `--wait` on the brief only when you expect an answer inside a couple of minutes — a plan, a question back. It blocks your turn exactly as `sleep` would; for anything longer, send the brief without `--wait` and wait through the `process` tool (below).

**The child's environment is not yours.** `herdr agent start` launches the agent from Herdr's own environment, not from the pane you called it from: exported variables such as `PI_CODING_AGENT_DIR` and additions to `PATH` in your shell do not reach it. A child therefore gets the host's `pi` with the host's extension set and settings. When that is not what you want — a canary with a scratch agent dir, a child that must load a development build of an extension — set it up in the *child's pane* first with `herdr pane run <pane> 'export …'` so the shell that `agent start` drives already carries it, then confirm with `herdr pane process-info --pane <pane>` and `tr '\0' '\n' < /proc/<pid>/environ | grep PI_CODING_AGENT_DIR`. A child running against the wrong agent dir writes sessions and settings into it.

## Reading state without bloating your context

Every read costs you context you cannot get back. Climb this ladder and stop at the first rung that answers the question:

1. **`herdr agent get <name>`** — a few hundred bytes. `agent_status` is one of `idle`, `working`, `blocked`, `done`, `unknown`; `state_change_seq` tells you whether anything happened since you last looked; `agent_session.value` is the child's session JSONL path. This answers "is it still going" and "did it change" and should be most of your reads.
2. **`herdr agent read <name> --source visible --lines 15`** — the rendered viewport. Read it **only on a state change**, to see what the child is showing: an approval prompt, a question dialog, the plan-ready footer.
3. **`herdr agent read <name> --source recent-unwrapped --lines 40`** — the transcript tail, for deciding whether to steer.
4. **The session file.** `agent_session.value` is a JSONL you can grep without rendering anything: `rg -c '"toolCall"' <path>` counts tool calls; `rg '"name":"bash"' <path> | tail -5` shows the last commands. Use this to check *what the child actually did* rather than what it says it did.
5. **The file fallback.** For a completed answer the screen cannot hold, ask the child to write its full report to a file under `/tmp` and reply with only the path, then `read` the file. pi runs on the terminal's alternate screen, so rows that scroll off it never enter Herdr's scrollback and a larger `--lines` cannot recover them. Use this after a read fails, not in the initial brief.

Never poll with `sleep` in your own bash, and never read a whole transcript.

## What each status means, and what to do

The pi integration reports lifecycle through hooks, not screen scraping (`screen_detection_skipped: true` in `agent get`), so the status is authoritative. Do not infer "stuck" from a spinner.

- **`blocked` with a gate label** (`shell command`, or another Auto Permissions gate) — an approval prompt. Go to the policy below.
- **`blocked` with label `question` or `plan question`** — the child asked something with `ask_user_question` or Plan Mode's question tool. Read `visible`; the options are numbered. `herdr agent send-keys <name> <digit>` selects a single-choice option; for a multi-select, digits toggle and `enter` confirms; for the "Type something" row, select it and then `herdr agent prompt <name> "<text>"`. Answer only what the brief already settles. Anything that is really the user's decision — product intent, a tradeoff the brief did not cover — you ask the user with `ask_user_question` and relay; do not guess for them.
- **`blocked` with no label at all** — an older extension is asking without saying what; read `visible` and treat it like a question.
- **`idle` or `done`, and the footer shows `◆ plan · ready → /plan`** — the child finished a plan in Plan Mode and is waiting. Get the plan path from the widget or from the session file (`rg planPath <session> | tail -1`), read the plan, and if it matches the brief send `herdr agent prompt <name> "/plan"` and pick *implement here* from the menu with a digit. If it does not match, answer the menu with *keep planning* and steer.
- **`idle` or `done` with no plan pending** — the child stopped. Read `recent-unwrapped --lines 40` for its closing claims, then verify (below) before believing them.
- **`working` past the turn you expected, `state_change_seq` unchanged** — read `recent-unwrapped --lines 20`. A spinner over one long tool is fine; wait. The same command repeated, or work outside the worktree, is a steer.
- **`unknown`** — the pane holds something Herdr cannot classify. Read `visible`; the child may have exited or crashed. `herdr pane process-info --pane <id>` says what is running. If pi is gone, relaunch in the same pane with `--continue` so it picks up its own session rather than starting from nothing.

## Answering an Auto Permissions prompt

The prompt exists because the guardian escalated to a human. You are answering in the human's place, so the authority is bounded, and the bounds are these:

1. **Read the exact command first.** `herdr agent read <name> --source visible --lines 15`. Never send a digit blind.
2. **Approve only if both hold**: the command is inside the task you gave that child, *and* you would run it yourself in that worktree under the same ground rules. Approve with the digit of the allow option — read the layout below first.
3. **Otherwise block — with a reason.** Press `tab` to open the comment field, type one line that names the problem and the alternative, then select the block option. The comment reaches the child as a steer message. A bare block teaches the child nothing and it retries.
4. **Never select a standing approval.** Standing approvals outlive this orchestration.
5. **Never argue a deny rule.** If the prompt says the command matches a deny rule, that is policy, not a judgment call; block and steer to a different approach.
6. **Write it down.** Every approval and block goes in the notes file with the command text and your reason, and appears in the final report.

The option labels depend on the host's Auto Permissions config. Read them from the screen. The two layouts you will see:

```text
evaluation logging off        evaluation logging on
  1. Allow                      1. Allow — asking was unnecessary
  2. Block                      2. Block — asking was appropriate
                                3. Allow — asking was appropriate
  [3. Allow and stop asking     [4. Allow and stop asking
      about comparable commands]    about comparable commands]
```

With logging on, the allow options also grade the guardian: pick 3 when the prompt was reasonable and you are approving anyway, 1 only when the guardian should not have asked at all. Block is option 2 in both layouts. The "stop asking about comparable commands" row, whatever its number, is the standing approval you never pick.

An in-scope approval:

```text
$ herdr agent read stash-readme --source visible --lines 15
shell command — Auto Permissions needs approval
  git commit -m "docs(stash): name the Ctrl+S binding up front"
  1. Allow — asking was unnecessary   2. Block — asking was appropriate   3. Allow — asking was appropriate
$ herdr agent send-keys stash-readme 3
# notes: APPROVED stash-readme `git commit -m …` — commit in its own worktree is the task
```

A block with a steer:

```text
$ herdr agent read stash-readme --source visible --lines 15
shell command — Auto Permissions needs approval
  git push -u origin docs/stash-readme
  1. Allow — asking was unnecessary   2. Block — asking was appropriate   3. Allow — asking was appropriate
$ herdr agent send-keys stash-readme tab
$ herdr agent prompt stash-readme "Ground rule: no pushes. Leave the branch local; I will open the PR."
$ herdr agent send-keys stash-readme 2
# notes: BLOCKED stash-readme `git push -u origin …` — ground rule; steered to leave branch local
```

## Steering

`herdr agent prompt <name> "<message>"` while the child is `working` is delivered by its pi as a steer at the next tool boundary; while it is idle, it starts a turn. Steer when you see the same command repeated, work outside the worktree, drift from the objective, or a return to an approach you already blocked. Say what to do instead; "stop doing that" without an alternative produces a child that tries the next-worst thing. Do not steer to hurry a child that is working.

`herdr agent send-keys <name> esc` interrupts the current turn. Use it only to stop something destructive that is already under way, then steer; an interrupted child has lost whatever tool result it was waiting on.

## Waiting

You do not sleep, and `herdr agent wait` or `agent prompt --wait` in your own bash *is* sleeping — your turn is held for as long as the child takes. Waits run in the `process` tool, one per child, named so `process list` shows what each is for:

```
process start
  name:    orch-<name>-wait
  command: herdr agent wait <name> --until blocked --until idle --until done --timeout 1800000
  notify:  { onSuccess: "turn", onFailure: "turn" }
```

Then end your turn. The exit wakes you; `agent get` tells you which state it settled in. Check `process list` before starting a wait so a child never has two. If the installed `herdr agent wait` rejects repeated `--until`, use it with no `--until` — the default stops on any settled state.

For several children, start one wait each and handle wakes in order, one decision per turn. When two block at once, the second waits; that is fine.

A recurring or scheduled run is the same tool: a shell loop that prompts a child and sleeps *inside a process* is acceptable; a `sleep` in your own bash is not.

## Verifying

A child saying it is done is a claim. Before you report a requirement met, check it yourself against authoritative state: run the command the requirement named in the child's worktree (its directory is on disk; your own bash reaches it), read the diff, check the PR. The child's summary and the conversation are context, not proof. What you could not verify you report as unverified — never as done.

If a requirement failed, that is a steer, not a report: tell the child what you observed and what the requirement says, and wait again.

## Finishing

Per child, report: the task, worktree and branch, final status, every approval and block with the command and the reason, what you verified and how, and what remains. Leave panes open unless the user asked otherwise; they may want to read a child's transcript. Leave worktrees and branches for the user to merge under whatever rules the host has — you do not merge, and you do not clean up worktrees.

## When not to orchestrate

- **One task that fits one session** — do it here. A supervisor for a single child is a slower way to do the work yourself.
- **Headless fan-out with no approvals and no need to watch** — parallel review, research, cleanup — is `pi-subagents`, which runs children inside this session without panes.
- **A decision the approval policy does not cover** — a child that will need to do something you are not allowed to approve. Settle it with the user before launching, not mid-run when the child is blocked and the user is elsewhere.
