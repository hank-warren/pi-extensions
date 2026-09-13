# @hank-warren/pi-plan-mode

## 1.8.1

### Patch Changes

- Follow the installed `ask_user_question` schema instead of imposing a stale four-question limit, and recognize cancelled rounds with partial answers as cancellation rather than approval to act. Standalone fallback behavior is unchanged.

## 1.8.0

### Minor Changes

- Implementation now has an end. `plan_implemented`, a parameterless tool staged when implementation starts, lets the model close out an approved plan once its verification has passed; `/plan done` and a **Mark as implemented** menu item do the same by hand. Finishing archives the plan file to `plans/<session-id>.<n>.md` beside the live slot instead of leaving it to be overwritten, so a session that plans several times keeps every plan. **Start a new plan** archives on its way into Plan mode; **Clear**, `/plan exit` and `/plan off` still delete.

  A fresh implementation session shares its parent's plan file, so when it finishes, the parent's pointer names a file that has moved. The parent now notices on its next start, reports the archive, clears the stale pointer, and `/plan show` there renders the archived plan as history.

  Plan tools are staged on the `input` event rather than `before_agent_start`, so a newly staged tool ships with its guideline on the same turn instead of the next; the tool list changes only at the two mode transitions that already rewrite the system prompt, and staged tools are never withdrawn mid-session. Archives and writes to one plan slot are serialized, a plan replaced while it was being archived is left intact and reported, symlinked plan files are refused, and an archive the filesystem rejects leaves the active plan unchanged with an error notification.

  The planning prompt is shorter: the craft it used to restate lives only in `docs/plan-craft.md`, which the prompt names by path. The completion rule lists the same plan sections the craft doc teaches. The active-plan pointer reads `[APPROVED PLAN] Plan mode is off.` instead of `[PLAN MODE]`, so implementation turns no longer carry a marker that resembles the planning one.

## 1.7.1

### Patch Changes

- Report the "Proposed plan ready. What next?" menu to Herdr as blocked.

  The ready menu opens after the drafting turn settles, so Herdr's pi integration had already marked the pane `idle` while it was actually waiting on a human to pick implement / export / stay / discard — a supervising agent in another pane read that as nothing happening. Plan Mode now emits the same `herdr:blocked` signal the question tool uses, labelled `plan ready` so a supervisor can tell it from a mid-draft `plan question`, and clears it however the menu closes. No-op outside `HERDR_ENV=1`.

## 1.7.0

### Minor Changes

- 1035138: Ship the craft documents by injected path instead of as skills.

  The `pi-loop` and `pi-plan-mode` skills are gone. Their bodies now ship as
  `docs/loop-craft.md` and `docs/plan-craft.md`, and the mode prompts inject the
  file's absolute path (resolved from the installed package) at the moments the
  guidance matters: while a loop is being drafted or completed, and while Plan
  Mode is active. A skill's description line sits in every system prompt of every
  session with the package loaded; across ~220 sessions after these two shipped,
  every read of either file was triggered by the mode's own prompt and never by
  the description, so the line was a tax on the ~95% of sessions that never
  entered the mode. Same document, read at the same moments, at zero cost outside
  them. Hosts that referenced the skills by name in settings should drop those
  entries.

### Patch Changes

- 1035138: Report a waiting question to Herdr as `blocked`.

  `ask_user_question` and Plan Mode's `plan_mode_question` now emit the same
  `herdr:blocked` event pi-auto-permissions emits for an approval prompt, labelled
  `question` / `plan question` and cleared in a `finally`, so Herdr's pi
  integration shows a session waiting on a question as `blocked` rather than
  `working`. A supervising agent in another pane can wait on that state and answer
  the dialog. No-op outside Herdr.

## 1.6.0

### Minor Changes

- d0c46a5: Drop two legacy paths that were past their delete-by date:

  - The one-shot repair of a thinking level left raised by a pre-1.3.0 session, and the "thinkingLevel is no longer used" row in the settings menu. An unknown `thinkingLevel` key in `pi-plan-mode.json` is still preserved verbatim on save.
  - The `plan-mode.json` settings fallback and its "Using legacy…" / "ignored because…" notices. Only `$PI_CODING_AGENT_DIR/pi-plan-mode.json` is read now; a host still on the old filename gets defaults and should rename the file.

  Internally, the settings watcher and the menu/workflow lifecycle moved into their own modules and the state transitions share one helper; nothing else about `/plan` changed. `engines.node` now states Pi's own floor, `>=22.19.0`.

## 1.5.0

### Minor Changes

- c079c51: Keep the completed plan out of model context, stage the Plan tools, and fail honestly when a plan cannot be saved.

  The completed-plan card is a display-only session entry rendered through `registerEntryRenderer` instead of a message, so the plan stays visible and restorable in the transcript while never entering model context or compaction. `plan_mode_complete` returns a one-line `Plan saved to <path>.` pointer; the durable file remains the handoff.

  `plan_mode_complete` now writes the file first and throws when the write fails, rather than reporting success and returning `undefined`. Prior state stays intact and the call is retryable.

  `plan_mode_complete` and the `plan_mode_question` fallback activate when Plan mode is entered or restored, so a session that never plans does not carry their schemas. Ownership of `ask_user_question` is resolved by package directory and read back from the host rather than assumed from the write, and every reconcile is announced on an event, so the fallback no longer depends on hook order between packages. A headless run has no legitimate question tool, so the prompt and the finalize steer switch to a plain-text variant instead of naming a tool that both packages strip.

  `AbortSignal` is wired through the question tool with exactly-once cleanup.

## 1.4.0

### Minor Changes

- 449f989: Ships a companion `pi-plan-mode` skill, making this a hybrid package: the system prompt stays the short enforcement surface and points at the skill for the plan-crafting craft — what decision-complete means, exploring before asking, what separates a question worth asking from one the repository already answers, and what a finished plan contains.

  The footer status and the editor widget now render from one formatter, so they cannot drift, in a glyph vocabulary shared with `pi-loop`: `◆ plan · drafting`, `◆ plan · revising`, `◆ plan · ready → /plan`, `▶ plan · implementing`, each with a dim hint line in the widget. Statuslines that render extension statuses will show the new strings in place of `plan active` / `plan ready` / `plan implementing`.

## 1.3.0

### Minor Changes

- 9dd9833: Remove the plan-mode thinking level. Plan mode no longer mutates session-global state: `pi.setThinkingLevel` writes through to the user's real settings, so the "temporary" level was a durable change that needed three shadow state fields, a `thinking_level_select` listener and restore logic on every exit path to undo. Thinking level and model are session settings now, and whatever you choose while planning carries into implementation. The `thinkingLevel` setting is gone and `/plan settings` drops its row; an existing key in `pi-plan-mode.json` is ignored rather than rejected — preserved verbatim on save, and no longer validated, so even a garbage value keeps the file loading. A one-shot migration restores the level an interrupted pre-1.3.0 session left raised, but only while the live level still matches what plan mode applied.

## 1.2.1

### Patch Changes

- 3fbf632: Persist the thinking-level capture taken while restoring plan mode. The two restore paths applied the configured level without writing the captured previous one, and Pi's `setThinkingLevel` writes the new level into the user's settings — so a session that ended without `session_shutdown` lost the only record of the original level and the next restore captured the plan level as "previous", permanently raising the user's default. An unchanged restore still writes nothing.

## 1.2.0

### Minor Changes

- 358aa1f: re-read `pi-plan-mode.json` when it changes instead of only at session start

  The settings file was read once per session, so a hand-edit — or a Settings save
  from another session — did nothing until the next restart. That sat badly next to
  the plan file, which has been hand-editable and read from disk since 1.0.

  Plan mode now watches the settings file's directory (not the file: saves land
  through a temp file and an atomic rename, which replaces the inode) and re-reads
  on a 75 ms debounce, so one save costs one load.

  An unparseable file is still reported and replaced by the defaults at session
  start. Mid-session it is ignored and the last good settings stay in place: a
  reload sees the file the moment an editor touches it, so an invalid read is
  usually a partial write, and there is no context to report it through anyway.
  Deleting the file mid-session does restore the defaults.

  Session start now also honours the injected `settingsPath` dependency when
  reading, which previously only the Settings menu used — the two could disagree
  about which file they were looking at.

## 1.1.1

### Patch Changes

- 7d96995: Make every declared dependency accurate.

  `pi-permission-selector` no longer declares a `@earendil-works/pi-coding-agent` peer dependency. It imports nothing from it — the claim was left over from 1.0.0, which removed the extension and the selector monkey patch and turned the package into a pure library.

  `pi-auto-permissions` floors `@hank-warren/pi-permission-selector` at `^1.1.0` and `pi-plan-mode` floors `@narumitw/pi-tui-kit` at `^0.49.3`, in both cases the lowest version the package is actually tested against. Neither uses a feature the old floor lacked, so nothing changes at install time under caret resolution; the ranges simply no longer claim support that nothing verifies.

  `scripts/validate.py` now enforces that a package's Pi `peerDependencies` are exactly the Pi packages its shipped sources import, in both directions.

## 1.1.0

### Minor Changes

- c40a48d: prefer `ask_user_question` for Plan-mode decision questions when it is installed

  `plan_mode_question` renders through plain `ctx.ui.select` + `ctx.ui.editor`: no
  previews, no notes, no tabs, no digit hotkeys. When
  `@hank-warren/pi-ask-user-question` is present, Plan mode now asks through that
  tool instead, which has all of them plus checkbox multi-select.

  Detection is a runtime check for a tool named `ask_user_question` in the active
  tool set, re-evaluated every turn — there is no dependency between the two
  packages. When it is found, `plan_mode_question` is removed from the **active**
  tool set so the model never sees two overlapping question tools, and the
  Plan-mode system prompt names `ask_user_question` with its own bounds (1-4
  questions, 2-4 options, 2-6 when `multiSelect`) and its own decline signal. The
  tool stays _registered_ either way, so a historical transcript still resolves
  it.

  A standalone `pi-plan-mode` install is unchanged: `plan_mode_question` remains
  fully functional and the prompt reads exactly as before. It is now a legacy
  fallback, slated for removal in a future major.

## 1.0.1

### Patch Changes

- cf12677: ship CHANGELOG.md in the published tarball

## 1.0.0

### Major Changes

- 88572fe: Rewrite Plan mode around a durable plan file and stop managing tool permissions.

  Plan mode is now a mode of intent rather than a permission system. It blocks exactly `edit`, `write`, and `update_plan` while planning and leaves every other tool as configured, so Bash and extension-tool safety stays with your permission layer (for example `@hank-warren/pi-auto-permissions`).

  **Plan mode no longer calls `setActiveTools`.** It previously rewrote the session's active tool set on every turn, which stripped tools other extensions had registered — lazily connected MCP tools and on-demand channels such as pi-subagents' supervisor tool were removed mid-session and never reactivated, and extensions that manage their own tools on `before_agent_start` fought Plan mode for control. None of that can happen now.

  Completed plans are written to `<agent dir>/plans/<session-id>.md`. The plan file is the plan: session state stores only its path, the file can be hand-edited, and both implementation paths read it from disk. While a plan is active the model receives a one-line pointer to the file instead of the plan body, so plans survive compaction at negligible context cost regardless of size, replacing the previous reinjection of up to 50,000 characters.

  Breaking changes:

  - Removed settings `defaultPlanTools`, `bashPolicy`, `safeSubcommands`, and `implementationPlanRetention`. They are now ignored rather than rejected, so existing settings files keep loading. `thinkingLevel` and `defaultPlanExportPath` are unchanged.
  - Removed the pre-start tool selector and `/plan tools`.
  - Removed the separate saved-plan state and `/plan save`; there is one plan per session, and `/plan exit` deletes it.
  - Removed the legacy `<proposed_plan>` XML completion path; use `plan_mode_complete`.
  - The implementation handoff and fresh-session transfer now reference the plan file instead of inlining the plan text.
