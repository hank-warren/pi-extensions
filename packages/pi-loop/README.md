# pi-loop — long-running work for the Pi coding agent

Inspired by Claude Code's `/loop`, adapted to Pi: keep work moving across many turns, and keep long loops coherent across context compaction.

A loop is a **pacemaker** that owns its own work: it carries an objective, completion criteria and ground rules, and ends when the model calls `loop_complete` with cited evidence, its expiry arrives, a cap you set is reached, or you stop it. Every loop is planned with you and started from an approval card. **No other extension is required.**

Earlier versions could instead bind a loop to a [pi-goal](https://www.npmjs.com/package/@hank-warren/pi-goal) goal and let that extension own *whether the work is done*. That mode is gone as of 0.6.0, along with every `goal-state` reader: a loop now does everything the pairing did — objective, durable ledger, post-compaction re-anchor, evidence-gated completion — so the coupling bought nothing. A loop persisted before 0.6.0 that carries no objective adopts its focus text as one on restore, and pauses with an explanation when there is nothing to adopt.

pi-plan-mode's `plan-mode-state` is read fail-open — the only sibling state left — so a loop never injects into a planning conversation.

## Usage

```
/loop                    # the menu: plan a loop, or manage the one that is running
/loop get CI green       # skip the menu: open planning and say that first
```

That is the entire command surface. Everything else — status, pause, resume, stop, focus, cadence, settings — is in the menu, and every loop is created the same way: a drafting conversation, an approval card, and a start that only you can press.

### Planning is the only way in

```
/loop  →  launch menu  →  planning  →  loop_propose  →  approval card  →  you start it
```

Bare `/loop` with nothing running opens a menu whose first item starts planning; `/loop <text>` opens planning and sends `<text>` as the first drafting message, exactly as `/plan <prompt>` does. You describe what the loop should achieve and how you will know it is done, the agent drafts it, and `loop_propose` renders an **approval card**: the objective, the exact completion criteria the split will produce, the ground rules, the cadence and the caps. Nothing is running at that point. From the card you can start the loop here, start it in a **fresh session** that carries only the objective, change the cadence, keep editing, or cancel.

Earlier versions also accepted a typed start (`/loop 30m fix CI`), flags (`--max`, `--expires`, `--compact-at`), typed subcommands, and a mid-prompt `/loop` token that pointed the model at a `loop_start` tool. **All of it is gone as of 1.0.0.** Each of them authored an acceptance gate in one unreviewed line: the criteria a loop is frozen to were invisible until after it had started, the flags were invisible full stop, and the mandatory interval implied a pacemaker the loop does not have. The card shows all of it while it can still be changed, which made every one of those surfaces a worse version of the same thing.

The consequence worth knowing: `/loop status` is no longer a subcommand, so it seeds planning with the word "status". Open the menu instead — it is one keystroke, and it shows more.

`loop_propose` is the only loop tool the model can reach before a loop exists, and it **starts nothing**. There is no tool that starts, pauses, resumes, or stops a loop; those are yours.

### Ground rules

A loop runs with nobody watching, so the useful thing to fix in advance is not only what "done" looks like but what the loop must never do on the way there. `loop_propose` takes up to ten **ground rules** — "never touch production", "never force-push", "never edit a test to make it pass", "stay inside this worktree" — which appear on the card, cross into the loop's state when you approve it, and are injected into every turn's system prompt as hard constraints.

They are **constraints, not criteria**: they never enter `criteria.json` and never gate completion. "Never touch production" has no evidence that proves it; folding it into the objective would turn it into a criterion nobody can satisfy. If the only way forward violates one, the loop is told to stop and call `loop_wait`.

### Headless

Creating a loop needs the interactive menu, so print and JSON modes cannot start one — by design, since the approval card is what authorises a self-continuing loop. A loop **restored** into a headless session runs normally, which is what the fresh-session handoff relies on.

## What paces a loop

A **standalone** loop is paced by the session settling, not by the clock:

1. `/loop <interval> <objective>` dispatches the **first working turn immediately** — the loop never burns its first interval sitting idle.
2. Every `agent_end` with the loop still active records a continuation *intent*; the next fully settled idle boundary (`isIdle()` and no pending messages) dispatches it. Recording at `agent_end` and delivering at `agent_settled` is what lets the intent survive Pi's own retries and auto-compaction, which happen between the two.
3. A delivery Pi refuses keeps the intent, so the next settle retries it.

The interval is therefore a **fallback heartbeat**, not the pacemaker: it is re-armed from the last settle and can only fire after a whole interval of genuine idleness — a lost continuation, or an external wait. When it does fire it delivers a poke, exactly as before. A continuation always supersedes a coalesced wake rather than delivering both.

Consecutive fallback wakes that produce a no-op turn **double the next fallback delay**, capped at 4× the base interval; any user turn, or any loop-caused turn that did real work, resets it. Waking an idle loop harder than it needs is the failure mode that costs tokens for nothing.

### The `LOOP_OK` acknowledgement

A woken loop with nothing to do still costs a full turn, and the paragraph explaining that nothing needed doing is pure cost — nobody reads it, and the engine cannot distinguish it from work. So every wake ends with *"If nothing needs attention, reply `LOOP_OK` and stop."*

A reply that starts or ends with `LOOP_OK` and carries at most **300 characters** of remainder renders as a one-line chip (`✓ loop ok · queue still empty`) and counts as a wasted wake for the backoff — even when the model used a tool to check first, because looking and finding nothing is still nothing. The budget is fixed rather than configurable: an acknowledgement with a paragraph attached is just a turn, and a knob would let the protocol decay back into prose.

The chip is **display-only**. The stored message keeps its exact bytes, because rewriting them would break the prompt cache this whole design is built around.

### One cap, unlimited by default

`maxTurns` counts **every turn the loop caused** — settle continuations plus fallback pokes — and stops the loop when it is reached. It defaults to `null`: **unlimited**.

That default changed in 1.0.0, from 25. A turn budget is a proxy for cost, not for progress: a loop that hits one stops in the middle of the work, with nothing decided and no reason a user can act on, and the number that stopped it was never chosen against the work. The bounds that remain are the ones that stop a loop *for a reason* — its expiry (7 days), and the no-progress breaker that pauses a loop repeating itself. Set a number in Settings to opt back into a budget.

There used to be two caps: this one, and a `maxIterations` counter of **delivered wakes**. The wake cap bounded nothing the turn cap did not, because a settle-paced loop can run its whole life without delivering a single wake — so in practice the turn cap was always the one that tripped, and the second cap cost a settings field, a decision branch, a state field, and a paragraph of documentation to say so. Wakes are still counted and shown on the menu's Status screen; they just cap nothing.

A settings file or an in-flight loop still carrying the old pair keeps the **tighter** of the two: that is the bound it was already running under, and nobody has to rewrite settings to keep a cap they already chose.

## What a wakeup does

Each tick — fallback heartbeat or settled boundary — evaluates, in order:

1. **Expired?** Loops hard-expire after `maxLoopDuration` (default 7 days, or per loop from the proposal's `expires`, shown on the card and echoed at start) — a forgotten loop is bounded. The loop gets **one final turn** first: "write the current state into the ledger, start no new work, claim no completion", and the settle after it stops the loop. A loop that simply vanished at its deadline would leave its most recent state only in a conversation about to be closed. If that final wake cannot be delivered, the loop stops immediately rather than living past its deadline.
2. **Plan mode active?** Skip quietly; never inject prompts into a planning conversation.
3. **Agent busy?** Never interrupt: coalesce into a single pending wake delivered at the next fully-settled idle boundary. N missed ticks collapse into one poke.
4. **A declared wait?** A `loop_wait` whose deadline has not passed holds both drivers: the loop is not stalled, it is waiting on the world.
5. **The turn cap** (see [One cap](#one-cap)): stop.
6. **Settled boundary:** dispatch the recorded continuation — a pointer-sized message (`⟳ loop continue #6`) that points at the system prompt for the objective, exactly as the pokes do.
7. **Fallback heartbeat: poke.** The wake header, why it fired (stalled, or a wait that has elapsed), and the loop focus when set. Every poke carries a marker (`<!-- pi-loop-poke:<id>:<n> -->`) so a wakeup is identifiable as loop-injected rather than user-typed. The marker is **provenance only** — pi-loop coalesces wakes in its own state and never reads the marker back to drop a delivery.

**A poke never restates the objective.** The objective reaches the model through a byte-stable system append on the same turn, and duplicating it in the message would store another copy on every wake. That works because pokes are delivered as ordinary user messages, which pass through `before_agent_start`; a delivery path that bypassed it (for example `pi.sendMessage({triggerTurn})`, which calls the agent directly) would arrive with no append and would have to carry the objective again. The token-lean contract is pinned in `test/messages.test.ts`.

In the transcript, a poke renders as a one-line chip (`⏰ loop wake 4 · stalled`) via a markdown transformer. That hook is display-only by Pi's contract — the stored message and the model's context are untouched.

Expiry and the cap are evaluated whenever the session settles, so a loop ends as soon as the work does rather than at the next scheduled tick. Only the fallback heartbeat pokes; a settle continues.

The footer status and the widget above the editor render from **one formatter**, so they cannot drift: `⟳ loop 1/3 done · turn 4/∞ · 12m · next 14:32`, leading with criteria progress rather than budget burn, and with the loop focus dimmed beneath it in the widget. Attention states come first (`⏸ loop paused`, `⏳ loop waiting`, `⚠ loop blocked`), and the planning states use the same `◆` the sibling pi-plan-mode uses for a plan awaiting a decision. The Status screen in the `/loop` menu shows the full card, including the last tick's decision and reason.

## Objective, injection, and `loop_complete`

A loop puts its own objective in front of the model, under a cache-safe split:

- **Static per loop — the system prompt.** The objective, `loop_id`, ledger contract, and loop-mode rules are appended to the system prompt, **byte-identically on every turn of that loop**. Anthropic caches `tools → system → messages` as one prefix, so a moving value there (iteration, next wake) would invalidate the cache for the whole conversation every wake. It changes only when the loop does.

  `test/bytes.test.ts` pins the exact stored bytes of every loop message — anchor, continuations, re-anchor, wakes, expiry — with exact-equality assertions, checks none of them ends in trailing whitespace, and replays a loop through its persisted session-entry form to prove the rebuilt messages are byte-identical. The rest of the suite asserts with `match`, which a silently reworded message passes; a changed cache prefix is exactly the kind of regression that costs money without failing anything.
- **Dynamic per wake — the poke or continuation.** The tail message carries only the wake or turn number, the interval, and the focus, and points at the system prompt for the rest.

### `loop_complete` and the evidence gate

`loop_complete` was once deliberately thin, on the argument that stopping a pacemaker has a small blast radius. That argument does not survive the loop becoming the *only* long-work mechanism: a premature completion now abandons autonomous work outright, and the model doing the abandoning is the one that decided the work was done.

So completion is gated on the loop's own `criteria.json`. The tool takes a required **`evidence`** map of criterion id to a cited citation, and refuses when:

- a criterion has no entry (the refusal names each one, and marks those `criteria.json` still records as unmet);
- an entry cites an id that is not in the file (inventing ids does not satisfy the gate);
- an entry asserts completion instead of citing it: every word in it is a claim word ("done", "ok", "verified", "passes", "green", …), punctuation and case ignored, or the whole value is under four characters. One word the blocklist does not know — a command, a number, a filename — makes it specific, so terse citations like `404 → 200` and `tests: 0 fail` pass. (The floor used to be twelve characters, which refused both of those.)

The gate is deliberately **mechanical**: it cannot judge whether evidence is *good*, only that the model was made to look at every requirement and say something specific about each. The rules that make the citation worth anything — audit requirement by requirement, authoritative state over transcript, weak or merely consistent evidence is not enough, **effort exhaustion is not completion** — live in the tool description and the system append. With no readable `criteria.json` the gate degrades to "cite at least one specific thing", because the ledger is fail-open everywhere else too.

The `loop_id` match is retained, so a stale turn cannot stop a newer loop. The tool is registered **unconditionally**, never toggled with loop state, because tools are part of the cached prefix and mutating the tool set mid-session invalidates the conversation cache; with no standalone loop active it simply refuses.

There is no judge model: a second model grading the first is a bigger change than the criteria/evidence gate, and this is the rung that ships.

## `loop_wait`: the adaptive wake

Without it a loop has exactly one answer to "progress depends on something outside this session": keep continuing, and burn turns re-checking. `loop_wait` lets the model say what it is waiting for and roughly how long:

- **`reason`** (required, one sentence) is shown in the widget and on the menu's Status screen, and is the only record of what the loop was waiting for.
- **`resume_after_ms`** is optional and clamped to **[60s, 1h]**, with the clamped value echoed back. Below a minute a "wait" is polling, which is what the tool replaces; above an hour it stops being a wait and the fallback heartbeat covers it better. Omitting it keeps the loop quiet until something else wakes the session.
- The tool description carries the **cache-window guidance**: never poll for work Pi already notifies about, avoid ~300s (the prompt-cache dead zone, where the cache has just expired and the next turn re-reads the conversation at full price), use ≤270s only when actively polling external state, otherwise commit to 1200s+.

A wait **holds both drivers** — no settle continuation, no fallback poke — but does **not** pause the loop and does **not** cancel the pacemaker: it supersedes the next fallback wake, so a wait whose event never arrives still ends in a wake rather than in silence. The deadline timer is generation-guarded and re-armed on session start, so a deadline that passed while the session was away is due immediately.

The turn a wake delivers for an elapsed wait **counts against `maxTurns`** like any other, so a model that keeps re-arming a wait cannot run forever.

There is deliberately **no cancel tool**. The events that legitimately cancel a wait (you typing, an earlier wake arriving) are not the model's to report — so when one of them ends a wait, its reason rides along once on the next loop message as `Previous wait (cancelled): …` and is then dropped.

## Working unattended, and the `PI_LOOP_ACTIVE` contract

The posture in the system append is stated as mechanics rather than as rules to obey, because the mechanics are the reason: a session waiting on a modal is *busy*, and busy makes every continuation and every fallback tick skip. Nothing ends the loop until it expires. So: decide rather than ask, take the reversible path, record the decision in the ledger, and use `loop_wait` — the one way to ask that does not deadlock the session.

The subtle half is what to do with a *blocked* command. Reshaping one to get **around** a permission gate — splitting it up, obfuscating it, routing it through another tool, retrying variations until one is allowed — is forbidden outright, and it is the dangerous failure precisely because it *looks like progress*. But a guardian that blocks with a specific objection is naming something to fix, and fixing exactly that is the response it asked for. Treating every block as terminal would have made the loop stop at objections that named a one-word remedy.

What separates the two is a bound, which is why pi-loop publishes its state to the process while a loop is active:

| Variable | Meaning |
| --- | --- |
| `PI_LOOP_ACTIVE` | `1` while a loop is active; absent otherwise (a paused or stopped loop withdraws it) |
| `PI_LOOP_ID` | the loop's id, so a reader can tell one loop from the next |

This is a contract for other extensions, deliberately the same mechanism `pi-subagents` established with `PI_SUBAGENT_CHILD=1` — an environment variable, not an import, not a dependency, not an RPC. [pi-auto-permissions](https://github.com/hank-warren/pi-extensions/tree/main/packages/pi-auto-permissions) is the first consumer: while it is set, a guardian verdict that would have opened a modal instead returns the concern to the agent as a block, carrying a bounded number of revision rounds and then naming `loop_wait`. Nothing is approved that would not have been approved with a user present; only the delivery changes. Neither package needs the other installed, in either direction.

The `⚠ loop blocked` widget state remains, unchanged, as the backstop: it catches prompts from extensions pi-loop cannot influence, where there is no contract to read.

## Breakers

- **No progress.** The characteristic failure of an autonomous loop is not crashing, it is *restating*: the same paragraph of "here is what I would do next", turn after turn, calling no tools. pi-loop fingerprints the visible assistant text (SHA-256 over NFKC-normalised, case- and whitespace-folded text) of every tool-free loop-caused turn; `noProgressTurns` consecutive repeats (default 3, settings-tunable, `null` disables) **pause** the loop rather than stopping it — it stays configured, the widget says why, and Resume in the `/loop` menu (or your next message) continues it with a fresh safety epoch. A turn that called **any** tool, including `loop_wait`, is progress by definition and resets the counter; counting a declared wait is the false positive that made this class of breaker infamous.
- **Interruption classification.** A loop that answers every provider failure with "continue" retries into exhausted quotas and re-sends requests too large to succeed. So each class gets its own answer: usage/billing exhaustion **pauses** (retrying a quota window that has not reset just burns the cap), an unrecoverable auth error **pauses**, an aborted loop turn (`Esc`) **pauses**, a context overflow **compacts and then continues** regardless of what the usage gauge says — the failed request just disproved that reading — and a transient error simply continues, because the next continuation *is* the retry.

## The loop ledger

A multi-day loop cannot keep its state in the conversation: compaction is lossy by construction, and a summary of a summary drifts further from what happened every time. So the conversation stays the working memory, and two files become the record — under `~/.pi/agent/loop/<loop-id>/` (keyed by **loop id**: session ids are not stably exposed to extensions, and one session can run several loops in sequence):

- **`criteria.json`** — this loop's completion criteria, derived from the objective when the loop starts (bullets if you wrote a list, otherwise sentences, otherwise one implicit criterion) and echoed back to you so you can see what `loop_complete` will answer for. JSON deliberately, not Markdown: models rewrite prose they are asked to maintain far more readily than they rewrite a structured file. The model may change **only** the `passes` field, only with cited evidence, and may never add, remove, or reword an entry — a model allowed to rewrite its own acceptance criteria eventually rewrites them into something it has already achieved. A restore keeps the file it finds: re-deriving it on every session start would reset the flips the loop had earned.

  The derivation is grammar, not comprehension — "fix CI. it has been red since Tuesday." yields a `c2` demanding cited evidence for a piece of background — which is precisely why the card shows the result **before** the loop starts. Fixing the objective in the drafting conversation costs a sentence; discovering the same problem at completion costs the loop.
- **`PROGRESS.md`** — the agent-maintained ledger, created with a fixed four-section schema (current status / completed / **failed approaches and why** / next actions) so "update the ledger" means the same thing on every turn. Failed approaches matter most: nothing else remembers them once the conversation is compacted.

Both are **best-effort**. An unwritable home directory, a full disk, or a file hand-edited into invalid JSON degrades the loop to "no ledger" with a single warning; it never breaks the loop. `PROGRESS.md` is created and then never overwritten, so a session restart cannot erase days of ledger.

### The kickoff anchor

The system append carries the objective only while the loop is *active*, and contributes nothing once it stops. So `/loop` also stores **one** ordinary message per loop holding the objective data — trust boundary, `<loop_objective>`, `<loop_id>`, ledger path — which survives the loop stopping, a resume, and (as ordinary transcript) a compaction. It repeats the objective *data*, never the loop-mode *rules*: those govern active turns, which always get the append. Paid once per loop, not per wake.

## Loop-aware compaction

Long loops die by context exhaustion, not by failing. pi-loop owns the compaction path:

- **Proactive compact at a threshold** (default 70% of the context window, settings): at an idle boundary, pi-loop triggers `/compact` itself with loop-specific instructions — preserve the objective and acceptance criteria verbatim, **every failed approach and the reason it failed**, decisions and rationale, files modified, commands and unresolved errors, and the next 1-3 actions. The instructions explicitly **stop carrying prior summaries forward wholesale** and tell the next turn to re-derive status from the ledger and authoritative state instead: cumulative carry-forward grows the text while the information in it decays. Pending pokes are held until the compaction completes. Pi's reserve-token auto-compaction remains as the fault handler.
- **Loop-owned re-anchor**: when a compaction completes mid-loop, pi-loop dispatches one pointer-sized continuation at the next settle — re-read `PROGRESS.md` and `criteria.json`, continue from authoritative state, plus the next 1-3 actions lifted out of the summary that just replaced the conversation. The loop no longer goes quiet until the next wake. A re-anchor supersedes an ordinary continuation already queued: after a compaction, "re-read the ledger" is strictly the better instruction.
- Loop state itself lives in custom session entries, which compaction never touches, and survives session restarts (the timer re-arms on resume; expired loops are dropped with a notice).

## Settings

`~/.pi/agent/pi-loop.json` (absent file = defaults, never created implicitly; saves are atomic and preserve unknown fields), or `/loop settings`:

```json
{
  "maxTurns": null,
  "noProgressTurns": 3,
  "maxLoopDuration": "7d",
  "defaultInterval": "10m",
  "compaction": {
    "enabled": true,
    "threshold": 0.7,
    "instructions": null
  }
}
```

`maxTurns: null` means unlimited (the default); `noProgressTurns: null` disables the breaker. A file still carrying the superseded `maxIterations`/`automaticTurns` pair loads, keeping the tighter of them, and the next save rewrites it as `maxTurns`. `inlineInvocation` is gone with the inline token it controlled: a file still carrying it loads — an unknown field never fails a settings file — and the next save drops it. `defaultInterval` is the fallback heartbeat a proposal gets when it names none.

Settings are reachable from every `/loop` menu.

## Deliberate omissions

These were considered and cut, and the reasoning is recorded so they are not silently re-added:

- **No token or time budget accounting.** The only lifetime bound is the expiry. Budgets interact badly with compaction (which resets nothing in the accounting), and a loop that stops mid-task because it ran out of tokens is worse than one that stops because its deadline arrived and it wrote its state down.
- **No judge model.** Grading completion with a second model is a larger, more expensive change than the criteria/evidence gate; the gate is the rung that ships.
- **No `loop_blocked` tool.** `loop_wait` covers a real external dependency, and the no-progress breaker covers an impasse the model does not recognise as one. A third "I give up" tool mostly gives a model a way to stop early. `compaction.instructions` overrides the built-in template.

## The companion skill

The package is a hybrid: it ships the extension **and** a `pi-loop` skill (`skills/pi-loop/SKILL.md`), which carries the judgment the engine cannot encode — how an objective becomes falsifiable criteria, what the evidence gate accepts as a citation, when to declare a `loop_wait` instead of polling, what `PROGRESS.md` is worth, and when the work belongs in no loop at all.

It is **loaded on demand**: the planning hint and `loop_complete`'s prompt guidelines point at it by name, exactly as `pi-processes` does, and the model reads the body when it judges it needs it. Nothing about the guidance enters a stored loop message or the system append — those bytes are the cache prefix, and `test/bytes.test.ts` fails if any of them so much as mentions a skill.

Skill and extension version as one artifact on purpose: a skill describing an engine the installed extension does not have is the coupling failure this repository already learned once.

## Install

```bash
pi install npm:@hank-warren/pi-loop
```

**No other extension is required.** The only sibling state pi-loop reads is [pi-plan-mode](https://www.npmjs.com/package/@hank-warren/pi-plan-mode)'s, fail-open, so a loop never injects into a planning conversation — and it works fine without it.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
