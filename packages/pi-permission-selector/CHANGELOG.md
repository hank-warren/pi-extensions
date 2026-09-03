# @hank-warren/pi-permission-selector

## 1.4.1

### Patch Changes

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

## 1.4.0

### Minor Changes

- 36230c0: Let option labels grow, and wrap descriptions instead of cutting them off.

  `ask_user_question` no longer rejects a questionnaire because an option label
  is longer than 60 characters. The renderer already wraps label rows and clamps
  every line to the box's inner width, so the cap could only ever discard a
  questionnaire that would have rendered fine. Label length is now guidance in
  the schema description rather than a gate; an empty or whitespace-only label
  takes its place as the fatal case, and `header`'s 16-character cap is
  unchanged.

  The shared `OptionSelector` now wraps long option descriptions at the row's
  continuation indent instead of truncating them with an ellipsis.

## 1.3.0

### Minor Changes

- 3fbf632: Make backspace delete a whole character rather than half a surrogate pair. Both text-entry surfaces sliced UTF-16 code units, so one backspace after an emoji left a lone surrogate — an ill-formed string that was then submitted as an approval note or a free-text answer.

  `pi-permission-selector` adds a code-point-aware `removeLastCharacter` export (additive; the frozen shared surface gains a name and loses none), and `pi-ask-user-question` uses it for the custom-answer field.

## 1.2.0

### Minor Changes

- 464fe1e: fix: pasting into the ask-user-question custom-answer field was silently dropped

  pi-tui re-wraps pastes in bracketed-paste markers (`\x1b[200~ … \x1b[201~`) before they reach `handleInput`. The questionnaire dialog's free-text field only accepted printable chunks, so a paste — which contains ESC — fell through every key predicate into the inert branch and vanished. The note editor was unaffected because `handleCommentKey` buffers its own pastes.

  The bracketed-paste state machine inside `handleCommentKey` is now extracted as a new shared export, `consumePasteChunk` (pi-permission-selector minor), and the custom-answer field routes input through it: single-chunk and chunk-spanning pastes insert, multi-line pastes flatten to one line, and input trailing the end marker is re-dispatched as ordinary keys.

## 1.1.1

### Patch Changes

- 7d96995: Make every declared dependency accurate.

  `pi-permission-selector` no longer declares a `@earendil-works/pi-coding-agent` peer dependency. It imports nothing from it — the claim was left over from 1.0.0, which removed the extension and the selector monkey patch and turned the package into a pure library.

  `pi-auto-permissions` floors `@hank-warren/pi-permission-selector` at `^1.1.0` and `pi-plan-mode` floors `@narumitw/pi-tui-kit` at `^0.49.3`, in both cases the lowest version the package is actually tested against. Neither uses a feature the old floor lacked, so nothing changes at install time under caret resolution; the ranges simply no longer claim support that nothing verifies.

  `scripts/validate.py` now enforces that a package's Pi `peerDependencies` are exactly the Pi packages its shipped sources import, in both directions.

## 1.1.0

### Minor Changes

- 385212b: add an opt-in checkbox multi-select mode to `OptionSelector`

  Set `multiSelect: true` and supply `onSubmit` instead of `onSelect`. Rows render
  as `→ [x] 1. Label`, Space and `1`–`9` both toggle (a digit also moves the
  highlight and no longer commits), and Enter submits the checked options in list
  order — inert until at least one is checked, which the `(N)` in the hint line
  reports. Esc, the note editor and its comment delivery are unchanged, and
  `getChecked()` exposes the selection to hosts and tests.

  `keys.ts` gains `isSpaceKey`, handling plain and Kitty/`modifyOtherKeys`
  encodings, and joins the frozen export surface. Wrapped rows and descriptions
  now indent by the rendered prefix width instead of a hardcoded five columns, so
  they stay aligned under the label with a checkbox present.

  Every new option is optional and inert unless `multiSelect` is set, so
  single-select callers — including `pi-auto-permissions` approval prompts —
  behave identically.

## 1.0.1

### Patch Changes

- cf12677: ship CHANGELOG.md in the published tarball

## 1.0.0

### Major Changes

- 500fe67: Remove the `ExtensionSelectorComponent` monkey patch; compose `OptionSelector` explicitly (spec §9.4).

  `pi-permission-selector` is now a **pure library**: it no longer registers an extension, patches nothing, and standalone installs do nothing — the reason for the major bump. `selector-patch.ts` and `index.ts` are deleted; `keys.ts` and `selector.ts` remain the frozen cross-package surface. Dialogs this repo does not own (pi's model/theme/session pickers, third-party extensions) revert to stock arrows+Enter, an accepted trade-off (spec §9.3): nothing here breaks when a pi upgrade changes selector internals.

  `pi-auto-permissions` renders both of its prompts — the guardian approval prompt and the `request_override` prompt — through `ctx.ui.custom()` with the shared `OptionSelector` from `@hank-warren/pi-permission-selector` (a new plain dependency), instead of `ctx.ui.select` plus the global patch. Behavior is preserved: numbered options with `1`–`9` hotkeys, Tab-to-comment on the approval prompt (the note is still delivered as a steering user message, now by pi-auto-permissions itself), exact legacy option strings for `classifyPromptChoice`, and Herdr blocked-state bracketing. Cancellation semantics match `ctx.ui.select`: Esc, abort of the prompt signal, and a host that cannot render custom UI all resolve `undefined`, which every caller treats as deny/cancel — never allow.

## 0.3.2

### Patch Changes

- 716a6a7: Wrap option rows and the key hint instead of overflowing.

  A typed note renders inline on the highlighted row (`→ 1. Allow, note▌`) and has no length limit, so a long note ran past the caller's box and was truncated or spilled into whatever was behind it. Rows now wrap, with continuation lines indented so a wrapped note reads as part of its row rather than as a new option, and the caret survives the wrap.

  The same fix covers long option labels, and the key hint line — which grows with every enabled feature and overflowed on narrow dialogs — now wraps too.

  This is the note-editor twin of the custom-answer wrapping fixed in `pi-ask-user-question` 0.2.2. Both text-entry paths now wrap; `wrapRow` is exported so the behavior is directly testable.

## 0.3.1

### Patch Changes

- f5fc550: Wrap option rows and the key hint instead of overflowing.

  A typed note renders inline on the highlighted row (`→ 1. Allow, note▌`) and has no length limit, so a long note ran past the caller's box and was truncated or spilled into whatever was behind it. Rows now wrap, with continuation lines indented so a wrapped note reads as part of its row rather than as a new option, and the caret survives the wrap.

  The same fix covers long option labels, and the key hint line — which grows with every enabled feature and overflowed on narrow dialogs — now wraps too.

  This is the note-editor twin of the custom-answer wrapping fixed in `pi-ask-user-question` 0.2.2. Both text-entry paths now wrap; `wrapRow` is exported so the behavior is directly testable.

## 0.3.0

### Minor Changes

- f470d81: Multi-question support with Tab cycling, matching `@juicesharp/rpiv-ask-user-question`.

  `MAX_QUESTIONS` rises from 1 to 4. Several questions render as tabs: `Tab` / `→` move forward, `Shift+Tab` / `←` move back, both wrapping, with a strip showing which questions are answered. Answering jumps to the next unanswered question, and the call returns once every question has an answer. Cycling back and re-answering replaces that question's answer instead of recording a second one — answers are keyed by question index.

  `n` now opens the note editor in the questionnaire, because `Tab` is needed for cycling. `pi-auto-permissions` approval prompts are unchanged and keep `Tab` for notes: `OptionSelector` gains a `commentTrigger` predicate that defaults to `Tab`, and only the questionnaire overrides it.

  Cycling is deliberately inert while a text field owns the keyboard, so a stray `Tab` cannot teleport you to another question and strand a half-typed answer.

## 0.2.0

### Minor Changes

- f52494b: Extract the selector's key handling and comment-mode state into `keys.ts`, and add a composable `OptionSelector` component in `selector.ts`.

  Both are new exported modules consumed by sibling packages through the published tarball, so they are added to the `files` allowlist and pinned by a contract test. `selector-patch.ts` now re-exports from `keys.ts` instead of carrying its own copies, so the monkey-patch path and the composable component share one implementation and cannot drift.

  No behavior change: the global patch still applies to every `ctx.ui.select` dialog exactly as before. `OptionSelector` exists so packages can get the same numbered options, digit hotkeys and Tab-to-comment by composing a component through `ctx.ui.custom()` rather than by patching pi internals.
