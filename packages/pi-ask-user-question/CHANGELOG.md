# @hank-warren/pi-ask-user-question

## 0.6.0

### Minor Changes

- c079c51: Announce tool availability on a new event, and stop mistaking a symlinked install for somebody else's package.

  Every reconcile now emits `hank:ask-user:availability` (`ASK_USER_AVAILABILITY_EVENT`) with `{ available: boolean }`, letting a consumer such as pi-plan-mode decide whether its own fallback question tool is needed without racing hook order. Availability is read back from the host rather than assumed from the write, because Pi silently ignores a name excluded by `--tools` or a tool policy, and a false positive would leave an interactive session with no question tool at all.

  The check for whether the registered `ask_user_question` is still backed by this package now canonicalizes both paths before comparing. `import.meta.url` is realpath-resolved by Node while Pi passes `sourceInfo.baseDir` through untouched, so every workspace, pnpm, and `npm link` install compared two spellings of the same directory, concluded the tool belonged to someone else, and never restored it after the first headless run. A path that cannot be resolved falls back to a lexical compare rather than failing closed.

  `AbortSignal` is wired through the questionnaire with exactly-once listener cleanup, and the blocked signal is always cleared in a `finally`.

## 0.5.3

### Patch Changes

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

- Updated dependencies [36230c0]
  - @hank-warren/pi-permission-selector@1.4.0

## 0.5.2

### Patch Changes

- 3fbf632: Make backspace delete a whole character rather than half a surrogate pair. Both text-entry surfaces sliced UTF-16 code units, so one backspace after an emoji left a lone surrogate — an ill-formed string that was then submitted as an approval note or a free-text answer.

  `pi-permission-selector` adds a code-point-aware `removeLastCharacter` export (additive; the frozen shared surface gains a name and loses none), and `pi-ask-user-question` uses it for the custom-answer field.

- Updated dependencies [3fbf632]
  - @hank-warren/pi-permission-selector@1.3.0

## 0.5.1

### Patch Changes

- 464fe1e: fix: pasting into the ask-user-question custom-answer field was silently dropped

  pi-tui re-wraps pastes in bracketed-paste markers (`\x1b[200~ … \x1b[201~`) before they reach `handleInput`. The questionnaire dialog's free-text field only accepted printable chunks, so a paste — which contains ESC — fell through every key predicate into the inert branch and vanished. The note editor was unaffected because `handleCommentKey` buffers its own pastes.

  The bracketed-paste state machine inside `handleCommentKey` is now extracted as a new shared export, `consumePasteChunk` (pi-permission-selector minor), and the custom-answer field routes input through it: single-chunk and chunk-spanning pastes insert, multi-line pastes flatten to one line, and input trailing the end marker is re-dispatched as ordinary keys.

- Updated dependencies [464fe1e]
  - @hank-warren/pi-permission-selector@1.2.0

## 0.5.0

### Minor Changes

- 385212b: add `multiSelect` questions

  A question with `multiSelect: true` renders as checkboxes for the cases where
  several answers hold at once ("which of these packages should change", "which
  checks to run before merging"). Space or a digit toggles a row, Enter submits
  the checked options, and the answer comes back as the chosen labels joined with
  `", "` — `answer` stays a plain string, so the envelope and every consumer of
  `details.answers` are unchanged. The parts are also available as
  `answers[].selected`.

  Multi-select questions may carry 2-6 options instead of 2-4; the
  `bad_option_count` message now names the mode and its range. Previews work on
  multi-select options (the pane keys off the highlighted row), though
  multi-select answers carry no `preview` into the envelope.

  Checking the appended `Type something.` row opens the free-text field with the
  other ticks preserved, and the typed value is **appended** to them rather than
  replacing them, so `pi-stats, pi-plan-mode, and also the docs site` is one
  answer. Such an answer records `custom: true`.

  `hank:ask-user:prompt` payloads gain an optional `multiSelect` field, emitted
  only when true — append-only, no new channel.

### Patch Changes

- e05dfb5: render the questionnaire in the editor area instead of as an overlay

  An overlay is composited over the bottom rows of the viewport, so the transcript
  underneath the dialog was unreachable: you are already scrolled to the bottom of
  the session and there is nothing left to scroll. Several lines of chat sat
  behind the box with no way to read them while answering.

  The dialog now mounts in the editor area — where `ctx.ui.select` renders pi's
  own selectors, and where `pi-auto-permissions` already puts its approval prompt.
  In the normal document flow the transcript is pushed up rather than covered, so
  every line stays readable in the terminal's own scrollback.

  Nothing else changes: same box, same keys, same width behavior. The input dock
  is replaced for the duration of the questionnaire and restored when it closes.

- Updated dependencies [385212b]
  - @hank-warren/pi-permission-selector@1.1.0

## 0.4.2

### Patch Changes

- cf12677: ship CHANGELOG.md in the published tarball
- Updated dependencies [cf12677]
  - @hank-warren/pi-permission-selector@1.0.1

## 0.4.1

### Patch Changes

- Updated dependencies [500fe67]
  - @hank-warren/pi-permission-selector@1.0.0

## 0.4.0

### Minor Changes

- 716a6a7: Add the preview pane — the last capability gap versus `@juicesharp/rpiv-ask-user-question`.

  Options may carry an optional `preview` field: markdown rendered in a pane below the options while that option is highlighted, using pi's own markdown theme so previews match the transcript. The pane follows the highlight and disappears for options without one.

  Stacked rather than side-by-side, per `docs/specs/pi-ask-user-question.md` §6.2 — rpiv spent ~712 lines largely on making a two-column layout behave at narrow widths. Long previews are clipped at 12 rows with a `… N more lines` marker so the options can never be pushed off screen.

  The chosen option's preview is carried into the tool result as `selected preview: …`, matching rpiv's envelope. A typed custom answer never carries one.

  Markdown rendering degrades to plain wrapped text rather than throwing: pi's `getMarkdownTheme()` returns lazily-bound functions that throw until `initTheme()` has run, and a throw inside `render()` would take down the whole dialog instead of one pane.

### Patch Changes

- Updated dependencies [716a6a7]
  - @hank-warren/pi-permission-selector@0.3.2

## 0.3.0

### Minor Changes

- f470d81: Multi-question support with Tab cycling, matching `@juicesharp/rpiv-ask-user-question`.

  `MAX_QUESTIONS` rises from 1 to 4. Several questions render as tabs: `Tab` / `→` move forward, `Shift+Tab` / `←` move back, both wrapping, with a strip showing which questions are answered. Answering jumps to the next unanswered question, and the call returns once every question has an answer. Cycling back and re-answering replaces that question's answer instead of recording a second one — answers are keyed by question index.

  `n` now opens the note editor in the questionnaire, because `Tab` is needed for cycling. `pi-auto-permissions` approval prompts are unchanged and keep `Tab` for notes: `OptionSelector` gains a `commentTrigger` predicate that defaults to `Tab`, and only the questionnaire overrides it.

  Cycling is deliberately inert while a text field owns the keyboard, so a stray `Tab` cannot teleport you to another question and strand a half-typed answer.

### Patch Changes

- Updated dependencies [f470d81]
  - @hank-warren/pi-permission-selector@0.3.0

## 0.2.2

### Patch Changes

- d60e648: Anchor the questionnaire above the input dock, and wrap long custom answers.

  **Position.** The overlay is now bottom-anchored and full width (`anchor: "bottom-center"`, `width: "100%"`, `margin.bottom: 0`), so it sits directly above the input dock instead of floating over the middle of the transcript — the geometry `@juicesharp/rpiv-ask-user-question` used. The dialog fills the overlay width to match; a narrower box inside a full-width overlay region would let the transcript show through beside it.

  **Wrapping.** Text typed into the "Type something." field ran past the right border and off the screen indefinitely, because an input field renders as one line unless something breaks it up. It now wraps on word boundaries, with a hard break for unbroken runs, and the caret follows to the last row.

  **Border integrity.** `render` now clamps any over-long line as a last-resort invariant, so no content source — a pathological option label included — can break the right border. `test/dialog-render.test.ts` asserts every rendered line is exactly the overlay width across widths from 20 to 200 columns; 8 of its 9 cases fail against 0.2.1.

## 0.2.1

### Patch Changes

- 8a479f1: Fix two dialog bugs that made 0.2.0 unusable in a Kitty-protocol terminal.

  **Trapped in the custom-answer field.** The free-text branch compared key data with `===` (`keyData === "\x1b"`) instead of using the shared predicates. Under the Kitty keyboard protocol — Ghostty's default — Esc arrives as `\x1b[27u`, Enter as `\x1b[13u` and Backspace as `\x1b[127u`, so all three were dead once the user selected "Type something.": no way to submit, no way to back out. The option list was unaffected because `OptionSelector` already used the shared predicates, and that asymmetry is what hid the bug. All key handling now routes through `@hank-warren/pi-permission-selector/keys.ts`, and Kitty-encoded printables are decoded rather than dropped.

  **Dialog rendered over the transcript.** Lines were emitted unpadded and unframed, and pi's overlay compositing only overwrites the columns an overlay actually emits — so chat text showed through and the dialog appeared as garbage interleaved with the conversation. The dialog now draws a border and pads every line to the full overlay width, wraps question text, and caps itself at 84 columns.

  Also adds `Focusable` support: the hardware cursor now parks in the text field via `CURSOR_MARKER` instead of sitting at the bottom of the screen.

## 0.2.0

### Minor Changes

- f52494b: Initial release: a structured questionnaire tool (`ask_user_question`) with numbered options, digit hotkeys, a "Type something." free-text row, and Tab-to-comment.

  v0.1 handles one question per call with 2-4 options; multi-question and preview panes follow in v0.2 (see `docs/specs/pi-ask-user-question.md`).

  The dialog composes the shared `OptionSelector` from `@hank-warren/pi-permission-selector` through `ctx.ui.custom()`, so it gets the same key behavior as approval prompts without patching any pi internals.

  The tool is stripped from the active tool set whenever `ctx.hasUI` is false, so headless subagent children can never block waiting on a human or route a question to their supervisor.

### Patch Changes

- Updated dependencies [f52494b]
  - @hank-warren/pi-permission-selector@0.2.0
