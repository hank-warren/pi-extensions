# @hank-warren/pi-loop

## 1.1.0

### Minor Changes

- c079c51: Stage the loop tools behind the workflow that needs them, and stop a loop that outlives its deadline.

  `loop_propose` activates when planning opens and the runtime trio (`loop_complete`, `loop_progress`, `loop_wait`) when a valid proposal exists, so a session that never touches `/loop` no longer carries four Loop-only schemas in its cached prompt prefix. Every tool stays registered, so a historical transcript still resolves it. An active loop re-asserts its runtime tools on every turn, which is what lets a paused loop restored in a later session be resumed and still finish itself.

  An expiry watchdog armed on the exact `expiresAt` now ends a loop that has gone quiet past its deadline, independently of the fallback interval, and a bounded grace period stops a loop whose final expiry turn never starts — `sendUserMessage` is fire-and-forget, so an accepted wake is not a delivered one. Terminal states persist a `terminalReason`, and callbacks are loop-identity guarded.

  Plan mode now owns the prompt outright: while it is enabled the loop injects neither its planning hint nor its objective, and resumes on the first turn after `/plan exit` without rewriting persisted state.

  The approval card is a display-only session entry rendered through `registerEntryRenderer` rather than a message, so it stays visible and restorable while never entering model context or compaction. The internal `LOOP_PROPOSAL_MESSAGE_TYPE` constant is replaced by `LOOP_PROPOSAL_ENTRY_TYPE`; it was never exported from the package entry point.

## 1.0.0

### Major Changes

- 449f989: `/loop` is menu-first, and planning is the only way to start a loop. Bare `/loop` opens a tui-kit menu (launch, planning, approval card, or manager, depending on state) and `/loop <text>` opens planning with that text as the first drafting message, mirroring `/plan <prompt>`. **Removed:** the typed start grammar (`/loop 30m fix CI`), its flags (`--max`, `--compact-at`, `--expires`), the typed subcommands (`status|pause|resume|stop|settings`), argument completions, mid-prompt inline `/loop` invocation, and the `loop_start` tool it pointed at. Each authored a loop's acceptance gate in one unreviewed line; the approval card now shows the objective, the exact derived criteria, the ground rules and the caps while they can still be changed. Pause, resume, stop, status, focus and cadence all live in the manager menu, and creating a loop now requires the interactive menu (a restored loop still runs headless).

  `loop_propose` gains `ground_rules`: up to ten hard constraints, approved with the objective, shown on the card, persisted in loop state so a fresh-session handoff carries them, and injected into every turn's system prompt as constraints rather than criteria — they never enter `criteria.json` and never gate completion.

  `maxTurns` now defaults to `null` (unlimited). A turn budget is a proxy for cost, not progress, and stops a loop mid-work for a reason nobody can act on; the expiry and the no-progress breaker remain the real bounds. The removed `inlineInvocation` setting is tolerated in existing settings files and dropped on the next save.

  The companion `pi-loop` skill is rewritten around the planning flow, cadence, ground rules and evidence.

## 0.9.0

### Minor Changes

- 897739d: Framed approval card, fresh-session launch, and a loop-safe permission posture.

  **pi-loop**

  - The approval card is now a framed `customType` transcript block, emitted once per draft, with its choices in an action menu. It used to go out twice and neither copy was a card: `loop_propose` returned it as tool-result markdown (re-spending the objective's tokens in the model's own context) and `/loop` re-printed it as a toast.
  - `startLoop` is split into `buildLoop` and `installLoop`, and the menu gains **Start loop in a fresh session** — the loop is built in the planning session and installed in a new one, so only the objective crosses and the drafting conversation does not.
  - A loop publishes `PI_LOOP_ACTIVE=1` and `PI_LOOP_ID` on the process while active. This is a contract for other extensions, mirroring `PI_SUBAGENT_CHILD`: no import, no dependency, no RPC.
  - The autonomy posture is reconciled with it. Reshaping a command to get _around_ a permission gate stays forbidden; revising it to satisfy a concern a guardian actually stated is legitimate and bounded. The `⚠ loop blocked` detector is unchanged.

  **pi-auto-permissions**

  - While `PI_LOOP_ACTIVE=1`, an `ask_user` verdict returns the guardian's concern to the agent as a non-blocking block instead of opening a modal. A session waiting on a modal is busy, and a busy session starves a loop's continuation path — the prompt would not be answered, it would deadlock the loop until it expired. **The verdict is unchanged; only its delivery is.** The absence of a user is never authorization.
  - Revision is bounded — per concern, per gate, and by consecutive blocked attempts — after which the block names `loop_wait` instead of inviting another try. The bounds survive a compaction and a session restore.

  Detection is fail-open in both directions: with the environment variables absent, behaviour is exactly as before, and neither package requires the other.

## 0.8.0

### Minor Changes

- 2a04a46: Plan mode, a ledger write tool, and a widget that shows progress.

  **Breaking: `/schedule` is removed.** It lived here because the machinery was the same
  machinery — an idle-gated delivery path, coalescing, caps, an expiry. True, and still the
  wrong home: a loop pursues one objective until it is done and then stops, while a schedule
  fires forever on a clock. Persisted tasks in `~/.pi/agent/loop/schedules.json` are no longer
  read and the `schedules.lease` lockfile is no longer taken.

  **`/loop` now opens planning.** With nothing running it starts a drafting conversation
  instead of printing "No loop in this session". The model drafts the objective as an
  acceptance test, then calls the new `loop_propose` tool, which renders an approval card
  showing the exact criteria the split will produce, the cadence and the caps — and starts
  nothing. You start it, change the cadence, keep editing, or cancel. The criteria used to be
  frozen before anyone had ever seen them; the card is the moment they can still be fixed.
  `/loop 30m <objective>` and inline `loop:` are unchanged.

  **Fixed: a wrapped bullet silently truncated its criterion.** `deriveCriteria` kept lines
  carrying a bullet marker and discarded the rest, so a bullet longer than a terminal width
  lost everything after its first line — while the criterion still looked well-formed. The
  acceptance gate was quietly weakened to whatever survived, with no signal.

  **New `loop_progress` tool, the only supported ledger write path.** The ledger is the one
  thing that survives compaction, and the model was told to maintain it with no tool to do so,
  so it reached for a shell heredoc — and one `cat > PROGRESS.md` replaced the objective line,
  the other sections and every failed-approach note. `loop_progress` edits one section and
  leaves every other byte alone, and marks a criterion met with the citation that justified
  it, stored alongside it. Only `passes` ever changes, now by construction rather than by
  prose in a skill file.

  **A blocking prompt no longer deadlocks the loop invisibly.** A session waiting on a modal
  is `busy`, which makes every continuation and every fallback tick skip; no turn completes,
  so the cap never trips and the no-progress breaker never fires. Expiry was the only thing
  left — up to seven days — while the widget showed a next-wake time throughout. Loops now
  carry an autonomy posture (decide and record rather than ask, `loop_wait` as the only
  non-deadlocking way to ask, never reshape a command to get past a permission prompt, prefer
  the undoable), and a run left open past fifteen minutes flips the widget to an attention
  state. The loop never answers the prompt.

  **The widget was redesigned around progress.** It led with the interval — a fallback
  heartbeat a settle-paced loop may never deliver — and reported turns against the cap, which
  is budget burn. Criteria met over total now leads, with the turn budget, the loop's age and
  the next wake after it. The widget and the footer render the same function: they had drifted,
  so a loop waiting on CI showed an ordinary next-wake time above the editor while the footer
  said it was waiting, and a paused loop dropped the cause that `/loop status` printed.

## 0.7.0

### Minor Changes

- 2ca10d6: Companion skill, one turn cap, model-proposed criteria, and a fairer evidence gate.

  - The package is now a hybrid: it ships a `pi-loop` skill (`skills/pi-loop/SKILL.md`) alongside the extension, loaded on demand via one prompt-guideline line in each of `loop_start` and `loop_complete`. It carries the judgment the engine cannot encode — writing objectives that become falsifiable criteria, what the evidence gate accepts, when to `loop_wait`, and when work belongs in no loop at all. Nothing skill-related enters any stored loop message or the system append.
  - **Breaking:** the two caps collapse into one. `maxIterations` (delivered fallback wakes) and `automaticTurns` (loop-caused turns) become a single `maxTurns` (default 25) counting every turn the loop causes — continuations and pokes. `--max` and the `loop_start` `max` parameter now set this turn cap instead of the wake cap. Settings files and persisted in-flight loops carrying the old keys migrate automatically, adopting the tighter of the pair; the next settings save rewrites them as `maxTurns`. The poke header drops its `n/cap` denominator (wakes are still counted and shown in `/loop status`; they cap nothing).
  - `loop_start` accepts an optional `criteria` array (at most 12 entries of at most 500 characters; a malformed list refuses the start). It replaces the deterministic grammar split when that split would misfire — context sentences becoming gate criteria, or several requirements packed into one sentence. Accepted only at start, echoed to the user, and frozen afterwards exactly like a derived set. Typed `/loop` starts are unchanged, and a restored loop now keeps the `criteria.json` it finds on disk instead of re-deriving it.
  - `loop_complete` no longer refuses terse-but-real evidence: the twelve-character floor rejected citations like `404 → 200`. Evidence is now refused only when every word in it is a claim word ("done", "verified", "passes", …) or the value is under four characters.

## 0.6.0

### Minor Changes

- b642391: Removing goal-bound loops is breaking for anyone holding one; it lands as a 0.x minor per this repo's convention.

  **Start a loop from an inline `/loop` invocation.** Pi dispatches `/loop` only when it is the first thing in the message, so `quick check /loop 10m get CI green` used to arrive as prose and vanish. A new `loop_start` tool, pointed at by a one-turn `<system-reminder>`, now starts the loop and begins working in the same turn. `loop: <objective>` at line start works the same way. The message itself is never rewritten, split, re-sent, or annotated: an `input` handler only records it, and `before_agent_start` appends the hint when the starting prompt is that same message.

  `loop_start` **refuses unless the inline hint armed for that turn.** A loop is self-continuing, so a spurious start does not produce one unwanted answer, it produces turns until a cap — that gate is enforcement rather than prompt guidance. It also refuses when a loop is already active, when `loop_complete` is missing from the active tool set, and on an unparsable objective, interval, or expiry.

  New settings: `inlineInvocation` (default `true`) and `defaultInterval` (default `"10m"`, used when an invocation names no interval).

  **Goal-bound loops are gone,** along with every `goal-state` reader, the completion-race clear-scan, and the goal outcomes in the tick and continuation decisions. A loop owns its objective, ledger, post-compaction re-anchor, and evidence-gated completion, so delegating completion to a second extension bought nothing and cost a coupling. `plan-mode-state` is now the only sibling entry pi-loop reads.

  A loop persisted before this release with no objective of its own adopts its focus text as one on restore, and pauses with an explanation when there is nothing to adopt.

  `@hank-warren/pi-goal` is deprecated in favour of this package. Its published versions stay installable.

## 0.5.0

### Minor Changes

- 55eab7e: pi-loop v2: long-running work, not just interval wakeups.

  - **Settle-paced.** A standalone loop now continues from the settled idle boundary instead of the clock: `/loop` fires its first working turn immediately, and the interval is demoted to a fallback heartbeat that only fires after a whole interval of genuine idleness. Consecutive wasted wakes back it off up to 4x. A new `automaticTurns` cap (default 25) bounds a loop that may now run many turns per wake; `maxIterations` keeps counting delivered wakes.
  - **A durable ledger.** Each loop gets `~/.pi/agent/loop/<loop-id>/` with `criteria.json` (derived from the objective; the model may change only `passes`) and `PROGRESS.md` (four fixed sections, including failed approaches and why). A kickoff anchor stores the objective in the transcript so it outlives the loop. Compaction instructions no longer carry summaries forward cumulatively, and the loop now owns its post-compaction re-anchor: one pointer-sized continuation that re-reads the ledger and carries the next actions out of the summary.
  - **`loop_wait`.** The model can declare an external wait with a reason and an optional deadline, clamped to [60s, 1h]. It holds both drivers without pausing the loop or cancelling the pacemaker, survives restarts, and its wake counts against the cap so a re-arming model cannot run forever.
  - **Breakers.** Consecutive tool-free loop turns with identical output pause the loop (default 3, tunable) while keeping it configured. Interrupted turns are classified: usage limits and unrecoverable errors pause, `Esc` pauses rather than re-sending, a context overflow compacts and continues, and a transient error simply continues. Deliveries that never become a turn, and a session with no `loop_complete` tool, also pause instead of spinning.
  - **Evidence-gated completion.** `loop_complete` requires a citation per criterion and refuses missing, unknown, or asserted-not-cited evidence. Expiry buys one final turn to write state into the ledger before stopping, and `--expires` sets a per-loop lifetime.
  - **`LOOP_OK`.** Wakes ask for a one-token acknowledgement when nothing needs attention; it renders as a chip and feeds the backoff. The stored bytes of every loop message are now pinned by tests, because they are part of the provider's cached prefix.
  - **`/schedule`.** Recurring prompts and headless `pi -p` runs, with once/interval/cron schedules, a single-writer lease so a task fires once rather than once per open session, coalesced catch-up, per-task run caps and a 90-day expiry, and a manager TUI. User-typed only: the model gets no scheduling tools.
  - **Goal-bound loops are deprecated.** They still work and warn; a restored one migrates itself to standalone unless its goal is still active. `@hank-warren/pi-goal` carries a matching deprecation banner.

## 0.4.1

### Patch Changes

- 3fbf632: Clear `nextWakeAt` when the wake timer fires, so `/loop status` can no longer report a "Next wake" clock time that has already passed. A tick that coalesces instead of firing — a busy or compacting session — left the old deadline in place, printing it directly above the line saying a wake is pending at the next idle boundary. Display only; no scheduling behaviour changes.

## 0.4.0

### Minor Changes

- e256c1f: loops can carry their own objective instead of requiring pi-goal

  A loop used to refuse to start without an active pi-goal goal, because the goal
  evaluator was the only stop criterion available to it. That made pi-loop
  unusable on its own and turned a missing goal into a dead end.

  A loop now has two modes, chosen when it starts:

  - **Standalone** — `/loop 30m until all tests pass and CI is green`. The loop
    carries its own objective and completion criteria, reads no goal state at
    all, and ends when the model calls the new `loop_complete` tool, a cap is
    reached, or you stop it.
  - **Goal-bound** — unchanged. An active goal wins, trailing text stays a
    per-wake focus, and pi-goal keeps owning completion, safety pauses, and
    stopping the loop when the goal finishes.

  Existing loops and commands behave exactly as before: with a goal active the
  mode selection resolves to goal-bound, and persisted loop state without an
  objective restores as goal-bound.

  `loop_complete` is deliberately thin next to `goal_complete` — a `loop_id`
  match so a stale turn cannot stop a newer loop, and no evidence-audit rules
  block, because stopping a pacemaker asserts nothing about whether the wider
  task is done. It is registered unconditionally rather than toggled with loop
  state: tools are part of the cached request prefix, so mutating the tool set
  mid-session would invalidate the conversation cache. With no standalone loop
  active it refuses.

  Standalone loops inject their objective under the same cache-stability contract
  pi-goal uses: a byte-stable system append per loop, with only the wake number
  and focus in the poke, so pokes stay pointer-sized in both modes.

### Patch Changes

- c7f0029: make "Unlimited" a real choice in the max-iterations setting

  `/loop` → Settings → Max iterations was a free-text box. Unlimited was
  reachable only by knowing to type the word `unlimited`, while the compaction
  row directly below it is a proper toggle. The value was accepted and saved
  correctly, so this is an affordance fix, not a behaviour fix.

  Picking the row now opens a choice — "Set a number…" or "Unlimited (no
  iteration cap)" — with the current value in the title. The typed word still
  works, so muscle memory and the `/loop --max unlimited` vocabulary are
  unaffected.

## 0.3.1

### Patch Changes

- 910f77a: stop invalidating the prompt cache, and stop re-sending the goal block every turn

  Goal mode has to keep the objective and its rules in front of the model on every
  turn. It did that twice: a full block appended to the system prompt with the
  running budget counter embedded in it, and a near-complete copy re-sent as a
  stored user message on every automatic continuation. pi-loop restated the
  objective a third time in every poke.

  Anthropic caches `tools → system → messages` as one prefix, so the moving budget
  counter invalidated the system _and_ conversation cache on every turn of a
  budgeted goal. Verified against the installed pi-ai Anthropic adapter
  (`buildParams` places `cache_control` on the system block and the last user
  message, and the `before_agent_start` append lands inside that cached block).

  **Static per goal.** The system append is now byte-identical across turns of the
  same goal and states only the budget _total_, so it changes only when the goal
  does — start, edit, clear — which is one accepted cache rewrite per boundary.
  Pinned as the cache-stability contract: same goal, different tokens used,
  iteration, and elapsed time produce identical output.

  **Dynamic per wake.** Kickoff, continuation, and poke messages shrink to
  pointer-sized triggers carrying the continuation number, budget usage, and wake
  reason, and point at the system prompt for the rest. Measured at ~4 chars/token:
  kickoff 805 → 53, continuation 840 → 54, poke 86 → 64, system append 807 → 820
  (+13 once per goal, the price of stability). Stored conversation tokens for a
  25-iteration goal: 20,965 → 1,349. The resume, edit, and waiting-resume prompts
  keep the full block — they are rare, user-initiated, and already a cache
  boundary.

  **Legibility.** Those messages now collapse to one-line transcript chips
  (`⟳ goal continuation #4 · budget 12k/100k`, `⏰ loop wake 4/25 · stalled`) via
  markdown transformers, which are display-only by Pi's contract: the stored
  message and the model's context are untouched. New goal and loop widgets above
  the editor carry the counters that left the system prompt — objective, budget
  fraction, iteration, automatic turns for the goal; interval, iteration/cap, next
  wake, and focus for the loop.

  **Cross-extension assumption.** pi-loop's poke no longer restates the objective,
  because loops require an active goal and pokes are ordinary user messages that
  go through `before_agent_start`, so every poke turn already carries pi-goal's
  system append. Documented in both READMEs; if pokes are ever delivered by a path
  that bypasses that hook, the poke must carry the objective again.

## 0.3.0

### Minor Changes

- 3e94f24: drop the post-compaction continuation and harden the loop engine

  **Removed:** the `postCompactContinuation` setting, the message it sent, and the
  `session_compact` handler behind it. pi-goal already re-prompts the session after
  a compaction for an active goal, and a loop requires an active goal, so pi-loop's
  follow-up only ever doubled the queued messages and the tokens they cost. pi-goal
  owns that message; pi-loop owns the compaction trigger and its instructions.
  Threshold compaction is unchanged. An existing `pi-loop.json` carrying the removed
  key keeps working — it is ignored, never rejected — but the settings row and the
  session surface are gone, hence the minor bump.

  **Terminal decisions at settle.** A settled boundary with no pending wake now
  evaluates expiry, completion, and pi-goal's safety states, so a loop stops the
  moment its goal does instead of up to one interval later. Poke and skip decisions
  are ignored there: only the timer pokes.

  **Delivery and compaction no longer lose or wedge state.** A poke is sent before
  it is accounted for, so a refused delivery re-arms on the same cadence instead of
  burning an iteration on a message that never arrived. A synchronous throw from
  `ctx.compact` resets the in-flight flag rather than leaving every later tick
  skipping as compaction-in-flight, and a failed compaction releases a held wake
  just as a successful one does.

  **Reading pi-goal through its completion clear** is now a bounded backward scan
  over consecutive clears, so a completion still stops the loop when other entries
  land on top of it. `resumeLoop` refuses a loop whose goal is gone, matching
  `startLoop`. Compaction instructions receive the goal only while it is active.

## 0.2.1

### Patch Changes

- 2b22273: Stop the loop with "goal completed" when pi-goal clears its state entry after completion. pi-goal persists the finished goal (status complete) and then writes a clear (goal: null), so by the loop's next tick the last goal-state entry was the clear and the loop paused as goal-missing instead of stopping as goal-complete. readGoalSnapshot now reads a completed goal through its completion clear; a clear over any non-complete goal (user /goal clear mid-flight) still pauses the loop.

## 0.2.0

### Minor Changes

- 4e16c70: Redesign inline invocation to be tool-mediated, fixing message loss, "Agent is already processing a prompt" errors, and uninterruptible turns caused by the input-splitting approach (extension-sent messages are never dispatched as commands, so the re-sent `/goal` reached the model as plain text and the user's prose was dropped).

  pi-goal: new `goal_start` tool reuses the `/goal` command's exact activation path; mid-prompt `/goal <objective>` and line-leading `goal: <objective>` invocations now append a one-line reminder to the otherwise-untouched message so the model calls the tool — nothing is cut, split, or re-sent. The `inlineInvocation` setting gates the reminder.

  pi-loop: loops now require an active pi-goal goal to operate — start refuses without one, a cleared goal pauses the loop, completion still stops it. `/loop` is user-typed only: the inline `/loop` input handler and the `pokePreamble`/`inlineInvocation` settings are removed, and the loop prompt is now an optional focus added to goal pokes.
