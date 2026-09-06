# pi-loop

The engine handles pacing, wakes, compaction, and the ledger. It cannot handle the three things that decide whether a loop is worth running: **what end state the objective names**, **what constraints bound the work**, and **what evidence proves it is done**. That is this file.

## How a loop comes into being

There is exactly one path, and it is a conversation:

```
/loop  →  launch menu  →  planning  →  loop_propose  →  approval card  →  the user starts it
```

`/loop` with nothing running opens a menu; its first item starts planning. `/loop <text>` skips the menu and makes `<text>` the first drafting message. From there **you draft with the user and call `loop_propose`**, which renders an approval card and starts nothing. The user starts the loop from that card — here, or in a fresh session that carries only the objective.

There is no typed start, no flags, and no inline token. Every one of them authored an acceptance gate in a single line that nobody reviewed, which is exactly the failure this flow exists to prevent. While planning is open, a conversational request for a loop is the signal to draft one and propose it — never to refuse and tell the user to type a command.

Everything after the start — pause, resume, stop, status, focus, cadence, settings — lives in the `/loop` menu. It belongs to the user, not to you: there is no tool for any of it.

## The objective is not a prompt, it is an acceptance test

The objective you pass to `loop_propose` is split into `criteria.json`, deterministically and without a model:

- **Bullets or a numbered list** (2+) → one criterion per item.
- Otherwise **sentences** → one criterion per sentence.
- Otherwise **the whole objective** → one implicit criterion.

Up to 12 criteria; each gets an id (`c1`, `c2`, …) and `passes: false`. `loop_complete` later demands **one cited piece of evidence per id**. So the objective's grammar decides the shape of the gate — and a conjunction *inside a sentence* does **not** split. "Fix the flaky test and update the docs" is a single criterion whose evidence must cover both halves; nothing will remind you of the second half. When the work has several requirements, write them as separate bullets on purpose.

The card shows the exact criteria the split produced **before anything starts**, which is the whole reason planning exists: they are frozen the moment the loop begins, and until the card existed nobody saw them until after that point.

Two rules follow:

1. **Name the evidence in the requirement itself.** "…, verified by `npm test` passing" pre-commits the citation, so completion is a lookup instead of an argument. Where a requirement names no check, its `check` field is empty and completion becomes an audit against authoritative current state.
2. **Keep each criterion checkable by one observation.** A criterion that needs three different commands to prove is three bullets.

**Draft the objective from what the user said, never a tidier version of it.** If they decline to name checks, say plainly what the gate will and will not catch, and let them decide.

| Vague as said | The end state to draft back |
| --- | --- |
| `make the tests better` | raise `packages/foo` line coverage above 80%, proven by `npm run coverage` |
| `fix CI` | the CI workflow green on this branch, proven by `gh pr checks` reporting all checks passed |
| `clean up the parser` | the duplicated token table gone from `src/parse.ts`, with `npm test` still passing |
| `investigate the memory leak` | no end state exists yet — see *When not to draft a loop* |

Two shapes need care because the split is grammar, not comprehension:

- **Requirements mixed with context** — "fix CI, it has been red since Tuesday" yields a criterion demanding cited evidence that CI has been red since Tuesday. Drop the background from the objective; it belongs in the conversation.
- **Several requirements in one sentence** — split them into bullets so neither half can be forgotten.

## Cadence: what actually bounds a loop

Cover this explicitly while drafting; the card shows all three.

- **Expiry** (`expires`, default 7 days) is the real bound. It grants one final turn to write state into `PROGRESS.md` — no new work, no completion claim.
- **The fallback heartbeat** (`interval`, default 10m) is *not* the pacemaker. The loop advances whenever the session settles, so a busy loop may never deliver a single wake. The heartbeat matters only for a session that has gone quiet. Pick it to match how long the loop might legitimately sit waiting on the world, not how often you want it to work.
- **The turn cap** (`max_turns`) is **unlimited by default**, deliberately. A turn budget is a proxy for cost, not for progress, and a loop that hits one stops mid-work with nothing decided and no reason a user can act on. Propose a number only when the user asks for a spend bound.
- **The no-progress breaker** pauses the loop after 3 consecutive tool-free turns with the same visible text. Restating a plan is the characteristic failure of an autonomous loop; calling any tool, including `loop_wait`, resets it.

## Ground rules: constraints, not criteria

`loop_propose` takes **`ground_rules`** — up to 10 short lines, each a hard constraint the loop must never violate. They are shown on the card, approved with the objective, and injected into the loop's system prompt on every turn as `Ground rules (hard constraints, never violate):`.

They never enter `criteria.json` and never gate completion. A criterion is something to reach; a ground rule is something never to do on the way there. Folding a constraint into the objective turns it into a criterion nobody can satisfy — "never touch production" has no evidence that proves it.

**Ask for them.** A loop runs with nobody watching, so an unstated constraint is one nobody enforces. The ones worth asking about:

- systems that are off limits (production, a customer's cluster, a shared branch);
- operations that must never happen unattended (force-push, `git reset --hard`, dropping a table, a release);
- the shape of the fix (never edit a test or fixture to make a check pass, never widen a permission, never add a dependency);
- blast radius (stay inside this worktree, one pull request, no merges).

Keep each one short and checkable by reading it. "Be careful" is not a ground rule.

## Completing: cite, do not assert

`loop_complete` refuses when:

- a criterion id is missing from `evidence` (the refusal names each one, and flags those `criteria.json` still records as unmet);
- an id appears that is not in `criteria.json`;
- an entry asserts rather than cites — *every* word in it is a claim word ("done", "ok", "verified", "passes", "green", "n/a", …), with punctuation and case ignored, so "Done." and "verified, passed" are refused too; or the whole value is under four characters.

One word the blocklist does not know — a command, a number, a filename — makes the value specific, so a terse citation is fine: `404 → 200` and `tests: 0 fail` both pass. Terseness is not the problem; asserting is.

Evidence is **the command and what it printed**, **the file and what it now contains**, **the URL and its state**. Previous conversation, your own plan, and a summary of a summary are context, not proof — and after a compaction they are a summary of a summary.

```
c1: "npm test → 214 passing, 0 failing (packages/pi-loop/test, full run at 14:02)"
c2: "gh pr checks 171 → all 3 checks passed (ci/gate, ci/typecheck, ci/scan-secrets)"
```

Audit requirement by requirement before calling it, and match the verification scope to the requirement scope: a criterion about the whole suite is not proven by one test file. **Effort exhaustion is not completion** — running long or running out of ideas is never a reason to call the tool. With no turn cap by default, there is no budget to "use up" as an excuse: if the criteria are not met, keep working.

## A loop runs unattended, so a question is a deadlock

Outside a loop, asking the user costs a few seconds of their attention. Inside one they are not
there by construction, and the cost is not a slow answer — it is the loop's death.

A session blocked on a modal prompt is **busy**, and `busy` is the third test in the decision
prefix both drivers share:

```
loop liveness -> expiry -> plan mode -> compaction -> busy -> wait -> the turn cap -> act
```

So `agent_settled` never fires and no continuation is queued; every fallback tick returns
`skip: agent-busy`; `automaticTurns` never increments, so a turn cap (if one was set) never trips;
and the no-progress breaker needs tool-free *turns*, of which there are none. **Expiry is the only
thing left, up to seven days later** — and the widget shows the next wake time the whole time.

This is why the guidance is a posture rather than a list of forbidden tools. Your other
extensions are unknowable and a blacklist goes stale the moment one of them ships a new prompt.
The rule follows from the mechanics instead:

1. **Decide, do not ask.** Take the reversible option, write the decision *and the reasoning*
   into `PROGRESS.md`, and keep going. The user reads it when they return and the loop never
   stopped. A decision recorded beats a question unanswered.
2. **`loop_wait` is the loop-safe form of asking.** It is the one way to say "I need a human"
   that does not deadlock: continuations stop, the reason shows in the widget and the `/loop`
   status screen, and any wake resumes it. Use it exactly where you would otherwise open a modal,
   and put the options in the ledger first so the answer can be one word.
3. **Never reshape a command to get *around* a permission gate.** This is the dangerous one. An
   autonomous agent has real incentive to rewrite a blocked command into something the guardian
   waves through, and that failure *looks like progress*. Splitting the command up, obfuscating
   it, routing it through a different tool, or simply retrying variations until one is allowed
   are all the same move, whatever the loop's state.

   Addressing a stated concern is not that move. A guardian that blocks with a specific
   objection — pi-auto-permissions does exactly this while `PI_LOOP_ACTIVE=1`, because a modal
   would deadlock the loop — is naming something to fix, and fixing precisely that is the
   response it asked for. The bound is what keeps the two apart: the block tells you how many
   revision rounds remain against that concern, and when they run out it stops offering the
   option and names `loop_wait` instead. A block that states no concern you can address is
   already final; do not spend the rounds on it.
4. **Prefer the undoable.** Nobody is watching to catch a bad call, so when two paths are close,
   take the one that is cheap to reverse: a worktree over the clone, additive over destructive, a
   draft pull request over a merge.
5. **Ask only when proceeding is irreversible *and* the choice is load-bearing.** Then use
   `loop_wait`, not a prompt.

A ground rule outranks all of this: if the only way forward violates one, stop and call `loop_wait`.

Autonomy is not permission to be reckless. It is the opposite: the absence of a human in the loop
is exactly why the reversible path is the right default.

## Waiting on the world

When progress depends on something outside the session — a CI run, a deploy, a human reply — call `loop_wait` with a one-sentence reason. Do not spend continuations re-checking, and never sleep in a shell to pass time.

- `resume_after_ms` is clamped to **[60s, 1h]** and the clamped value is echoed back. Omit it to stay quiet until something else wakes the session.
- Avoid ~300s: that is the prompt-cache dead zone, where the cache has just expired and the next turn re-reads the whole conversation at full price. Use ≤270s only when actively polling external state nothing else reports; otherwise commit to 1200s or more.
- Never wait for what Pi already notifies you about: background processes, subagents, and tool completions wake the session on their own.

`loop_wait` is for a genuine external event, never a way to end a turn early with work outstanding.

## PROGRESS.md is what a stopped loop is worth

The ledger lives at `~/.pi/agent/loop/<loop-id>/`, and `PROGRESS.md` has four fixed sections: current status, completed, **failed approaches and why**, next actions. It is created from a template; **write your first real update in the turn that starts the loop**, and keep updating it as you work rather than at the end. A ledger still holding the template is a loop with no memory.

The failed-approaches section carries the most value, because it is the only thing that survives compaction and the only thing that stops the next continuation — or the next engineer — from re-running an experiment that already failed. "Tried X, it failed because Y" is the whole point; "tried several things" is worth nothing.

Write both files with the **`loop_progress`** tool, never with the file or shell tools. `loop_progress` edits one section and leaves every other byte alone; a whole-file write takes out the objective line, the other three sections, and however many days of failed-approach notes were in them. That is not a hypothetical — it is what a `cat > PROGRESS.md <<EOF` does on the first ledger update, and `createLedger` opens the file with `flag: "wx"` precisely so the engine can never do it.

`criteria.json` sits next to it. Mark an entry met with `loop_progress`, which flips `passes` and stores the citation that justified it alongside the criterion, where `loop_complete` can be held to it later. Only `passes` ever changes: you may **never** add, remove, reword, or re-id an entry, and never hand-edit the file. A model that can rewrite its acceptance criteria eventually rewrites them into something it has already achieved.

Both files are best-effort. If the ledger could not be created the loop still runs; it just has no memory outside the conversation.

## When not to draft a loop

Planning being open *permits* a loop; it does not oblige you to propose one. When the work is a bad fit, say so in one line and offer the alternative instead:

- **Recurring cadence** ("check the release queue every morning") → not a loop. A loop pursues one objective until it is done and then stops; it is not a timer, and an objective that is never "done" only produces turns until it expires. Use whatever scheduling your setup provides.
- **Genuine open exploration** ("figure out why memory grows") → do the investigation in the conversation. A loop's value is the gate at the end; an investigation has no end state to gate on, so the loop only supplies unwanted turns. Once the investigation names a fix, *that* is a loop objective.
- **Work that finishes this turn** → just do it, and say why no loop was needed.

A vague-but-real objective is not in this list: draft the end state back and let the user correct it on the card.

A loop is self-continuing: starting one wrongly does not produce one bad answer, it produces turns until it expires.
