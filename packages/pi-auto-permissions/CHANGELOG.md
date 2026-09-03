# @hank-warren/pi-auto-permissions

## 0.16.1

### Patch Changes

- d0c46a5: Two fixes found by the live canary:

  - `/auto-permissions` → Recent denials → "Allow on retry" dispatched the retry while the settings menu was still open; the approval prompt then stacked on top of it and the composer stopped submitting until Pi was restarted. The menu now closes before the retry is sent.
  - With `ui.placement: "toolRow"`, a review waiting its turn behind another review rendered as `✗ blocked`; it now shows the queued frame.

  Internally `index.ts` was split into `classify.ts`, `guardian-reviewer.ts`, `review-display.ts`, `session-overrides.ts`, `settings-command.ts`, `prompt-select.ts` and `review-scope.ts`; the decision pipeline, prompts, log formats, session entries and events are unchanged and are now pinned by an extension-level test suite.

## 0.16.0

### Minor Changes

- c079c51: Serialize guardian-backed reviews, show a queued command instead of a blank gap, and stage `request_override`.

  Two guarded commands issued in the same assistant turn used to open two reviewer conversations at once and race for the same widget and bash review row, letting the second verdict land against the first command's display. Guardian reviews now run one at a time behind a FIFO queue. Denies, convention blocks, trusted commands, and already-approved execution never enter it, so the ordinary path is unchanged.

  Because the critical section spans the human approval prompt, a queued command now renders a `queued behind another review` row as soon as it starts waiting, and the wait is cancellable: `Esc` or a reviewer-lifecycle reset releases it immediately instead of stranding it behind a review it is no longer waiting for. An aborted waiter never lets the command behind it overtake the review still in progress.

  `request_override` activates only after a convention denial in an interactive session, so a session that is never blocked does not carry its schema. The tool stays registered for transcript replay.

## 0.15.0

### Minor Changes

- 33837be: `/auto-permissions setup` is now a pointer to the `auto-permissions-setup` skill: it dispatches the conversational setup on the keystroke and works outside TUI mode. The one-shot draft wizard (`setup-scan.ts`) is removed — a conversation can disambiguate look-alike hosts, weigh history-wide friction and back out of a bad suggestion, which a fixed accept-or-discard draft could not.

## 0.14.0

### Minor Changes

- 6e6a556: interactive setup skill (`auto-permissions-setup`), wizard proposes softDeny tiers with per-entry provenance, and a standing approvals ledger ("allow and stop asking about comparable commands") with a revoke submenu in `/auto-permissions`

## 0.13.0

### Minor Changes

- 488b4bd: Auto Permissions becomes a review-by-default competitor to Claude Code auto mode.

  **Migration note:** a fresh install (or a config with no `rules` key) now runs the built-in default ruleset — deny rules for agent-oversight bypasses and critical-path destruction, guardian review for force pushes, infrastructure destroys, credential access, and the other default groups. `"rules": []` restores the old gate-nothing behavior; an authored `rules` array is unchanged; `"$defaults"` inside an authored array splices the built-ins in.

  New in pi-auto-permissions:

  - `deny` rule level: a hard boundary that outranks every other match and cannot be cleared by `request_override`, `.pi/trusted-ops`, or user approval
  - Built-in default ruleset (9 groups) active when no `rules` key is authored, with `"$defaults"` splice support
  - `reviewAllShell`: blanket guardian review for commands no rule matches
  - `guardianPolicy`: prose trust configuration (environment / allow / softDeny / hardDeny) with four-tier precedence
  - Session-start trust snapshot: remotes captured once at session start; remotes added mid-session sit outside the trust baseline
  - Unresolvable destructive targets (`rm -rf "$VAR"` with no visible assignment) get `revise` naming the literal-path fix
  - Optional two-stage review: a stateless single-token SAFE/REVIEW prefilter (`reviewer.prefilter`) before full review, fail-closed
  - Delegated (subagent) tasks held to an explicit-intent standard; non-allowlisted custom messages become capped tool-source evidence
  - Denial ledger (`denials.jsonl`), Recent-denials + Allow-on-retry in `/auto-permissions`, an `auto-permissions:denied` event, and permission overrides that persist across session resume
  - `/auto-permissions setup`: a wizard that scans the project and recent session command strings (never user messages) and drafts `guardianPolicy.environment` entries plus trusted-ops suggestions

  pi-permission-selector: `OptionSelector` title lines now wrap to the render width instead of overflowing — an unwrapped reviewer-failure detail in the title crashed the whole session under pi-tui's width assertion.

### Patch Changes

- Updated dependencies [488b4bd]
  - @hank-warren/pi-permission-selector@1.4.1

## 0.12.1

### Patch Changes

- 895b323: Require `@hank-warren/pi-permission-selector` `^1.4.0`, the release where option
  descriptions wrap instead of being truncated. The old `^1.3.0` range resolved to
  1.4.0 only on a host that also installed a sibling asking for it; installed on
  its own, `pi-auto-permissions` could still satisfy the range with 1.3.x and
  present a silently different selector.

## 0.12.0

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

## 0.11.1

### Patch Changes

- 3fbf632: Stop evidence truncation from re-appending the whole record. With a per-record cap of 1-3 the head share rounded up to the entire budget, leaving a zero-length tail — and `slice(-0)` is `slice(0)`, so the "truncated" record was longer than its input and carried an elision marker for text the reviewer could still read. Caps of 4 and above, including every shipped default, are unaffected.
- Updated dependencies [3fbf632]
  - @hank-warren/pi-permission-selector@1.3.0

## 0.11.0

### Minor Changes

- f93481e: add `/auto-permissions`, a settings menu for the reviewer configuration

  The reviewer model, thinking level and timeout — plus the `enabled` flag — were
  hand-edited JSON. They are the settings that change most often, and switching a
  reviewer meant opening `~/.pi/agent/pi-auto-permissions/config.json` and getting
  a provider id exactly right by memory.

  `/auto-permissions` puts those four on a settings list, with the model picked
  from the models you are actually signed in to (a configured but unavailable
  reviewer is pinned first so opening the menu can never silently drop it). A
  fifth read-only row reports where the active system prompt comes from — the
  resolved `systemPromptFile` path, or the built-in or inline prompt.

  The menu is a narrow, merging writer: it patches only `enabled` and `reviewer`
  into whatever is on disk at save time, preserving rules, prompts, evidence
  settings, log paths, unknown keys and the file's own indentation, so a
  concurrent hand-edit survives. A config that fails validation is reported and
  never rewritten. No restart is involved — the config is already re-read on every
  guarded command, and the reviewer fingerprint already covers the model and
  reasoning effort, so a save takes effect on the next command in every session.

## 0.10.0

### Minor Changes

- 0e9400e: Remove the built-in `openai-codex-auto-permissions` provider. Additional logins are now the job of `@hank-warren/pi-multi-login`, which adopts the existing credential on first run, so an existing `reviewer.provider` config keeps resolving with no edit.

  Without that package installed the reviewer provider is missing; session start now warns once naming the provider instead of leaving the first guarded command to fail with a bare "review model not found".

## 0.9.0

### Minor Changes

- 7d96995: Stop `pi-herdr-auto-title` depending on `pi-auto-permissions`.

  The pane-title extension deep-imported `guardian-transport.ts` — roughly forty lines resolving `completeSimple` through the host `ModelRuntime` so provider extensions (Anthropic OAuth shaping) apply to background model calls. Reusing it cost an entire dependency on the permissions engine: 125 kB unpacked in `node_modules`, a transitive `pi-permission-selector`, and a no-op release of the title extension every time the guardian shipped.

  The file is now duplicated byte-for-byte into both packages, and `scripts/validate.py` fails if the copies drift. `pi-herdr-auto-title` declares no dependencies at all and its tarball is unchanged apart from the added source file.

  To keep the copies identical, `resolveGuardianCompleteSimple` takes the calling package's name as a second argument and uses it in the compat-fallback warning, replacing the hardcoded `[pi-auto-permissions]` prefix. That is a breaking change only for an external deep import of `@hank-warren/pi-auto-permissions/guardian-transport.ts`; the extension's own behavior is unchanged.

### Patch Changes

- 7d96995: Make every declared dependency accurate.

  `pi-permission-selector` no longer declares a `@earendil-works/pi-coding-agent` peer dependency. It imports nothing from it — the claim was left over from 1.0.0, which removed the extension and the selector monkey patch and turned the package into a pure library.

  `pi-auto-permissions` floors `@hank-warren/pi-permission-selector` at `^1.1.0` and `pi-plan-mode` floors `@narumitw/pi-tui-kit` at `^0.49.3`, in both cases the lowest version the package is actually tested against. Neither uses a feature the old floor lacked, so nothing changes at install time under caret resolution; the ranges simply no longer claim support that nothing verifies.

  `scripts/validate.py` now enforces that a package's Pi `peerDependencies` are exactly the Pi packages its shipped sources import, in both directions.

- Updated dependencies [7d96995]
  - @hank-warren/pi-permission-selector@1.1.1

## 0.8.0

### Minor Changes

- 52ff06e: Add a dedicated `OpenAI Codex - Auto Permissions` provider with its own OAuth credential slot, allowing guardian reviews to use a separate ChatGPT account without replacing the main OpenAI Codex login.

### Patch Changes

- 312da9a: Add a pulsing warning light to interactive approval prompts so they remain visually distinct from the surrounding transcript.

## 0.7.2

### Patch Changes

- 97918ec: move the review status widget above the editor so the prompt bar no longer shifts up and down as guardian status appears and disappears

## 0.7.1

### Patch Changes

- 3a904c3: Remove the two-space indent from the review widget's guardian detail line so it aligns with the status line above it.

## 0.7.0

### Minor Changes

- ad12ad0: Rename the eval-logging prompt's block option to "Block — asking was appropriate".

  Label clarity only — the schema is unchanged (`userChoice: "block"`, `expectedDecision: "ask_user"`). A block always affirms that asking was right: the guardian has no reject verdict (its non-approve outcomes are `ask_user` and `revise`), so the only true rejection in the system is the user's at this prompt. Plain "Block" from the logging-disabled prompt still classifies identically, including for override evidence.

## 0.6.1

### Patch Changes

- cf12677: ship CHANGELOG.md in the published tarball
- Updated dependencies [cf12677]
  - @hank-warren/pi-permission-selector@1.0.1

## 0.6.0

### Minor Changes

- 500fe67: Remove the `ExtensionSelectorComponent` monkey patch; compose `OptionSelector` explicitly (spec §9.4).

  `pi-permission-selector` is now a **pure library**: it no longer registers an extension, patches nothing, and standalone installs do nothing — the reason for the major bump. `selector-patch.ts` and `index.ts` are deleted; `keys.ts` and `selector.ts` remain the frozen cross-package surface. Dialogs this repo does not own (pi's model/theme/session pickers, third-party extensions) revert to stock arrows+Enter, an accepted trade-off (spec §9.3): nothing here breaks when a pi upgrade changes selector internals.

  `pi-auto-permissions` renders both of its prompts — the guardian approval prompt and the `request_override` prompt — through `ctx.ui.custom()` with the shared `OptionSelector` from `@hank-warren/pi-permission-selector` (a new plain dependency), instead of `ctx.ui.select` plus the global patch. Behavior is preserved: numbered options with `1`–`9` hotkeys, Tab-to-comment on the approval prompt (the note is still delivered as a steering user message, now by pi-auto-permissions itself), exact legacy option strings for `classifyPromptChoice`, and Herdr blocked-state bracketing. Cancellation semantics match `ctx.ui.select`: Esc, abort of the prompt signal, and a host that cannot render custom UI all resolve `undefined`, which every caller treats as deny/cancel — never allow.

### Patch Changes

- Updated dependencies [500fe67]
  - @hank-warren/pi-permission-selector@1.0.0

## 0.5.1

### Patch Changes

- 67abcf5: document the optional `HERDR_ENV` herdr pane blocked indicator
