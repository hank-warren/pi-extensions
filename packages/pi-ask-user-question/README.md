# @hank-warren/pi-ask-user-question

A structured questionnaire the model can put to you when it would otherwise
guess. Instead of a free-form "which do you prefer?" in chat, you get a dialog
with numbered options, digit hotkeys, a typed-answer escape, and Tab-to-comment.

> **v0.5** ships 1-4 questions per call as cycleable tabs, single- or
> multi-select, with an optional preview pane. See
> [the spec](../../docs/specs/pi-ask-user-question.md) §14.

## Install

```bash
pi install npm:@hank-warren/pi-ask-user-question
```

It must not be installed alongside `@juicesharp/rpiv-ask-user-question` — both
register a tool named `ask_user_question`.

## Keys

| Key | Action |
|---|---|
| `1`–`9` | Select that option immediately (toggle it, on a multi-select question) |
| `Space` | Toggle the highlighted option (multi-select only) |
| `↑` / `↓` | Move the highlight |
| `Enter` | Confirm the highlighted option, or submit the checked ones |
| `n` | Attach a note to your choice, then `Enter` to send both |
| `Tab` / `→` | Next question |
| `Shift+Tab` / `←` | Previous question |
| `Esc` | Decline the questionnaire (or leave note/typed-answer mode) |

With several questions, each is a tab you can cycle through in any order;
answering one jumps to the next unanswered question, and the call returns once
every question has an answer. Cycling back and re-answering replaces that
question's answer rather than recording a second one.

## Multi-select

A question with `multiSelect: true` renders as checkboxes, for the cases where
several answers hold at once — "which of these packages should change", "which
checks to run before merging":

```
→ [x] 1. pi-stats
  [ ] 2. pi-statusline
  [x] 3. pi-plan-mode
  [ ] 4. Type something.
  space/1-9 toggle · ↑↓ move · enter confirm (2) · n add note · esc cancel
```

- Space and the digit hotkeys both toggle; a digit no longer commits, so one
  keystroke cannot end the question early.
- Enter submits the checked options in list order and is inert until at least
  one is checked — the count in the hint is the tell.
- The answer comes back as the chosen labels joined with `, `.
- Multi-select questions may carry 2-6 options; single-select stays at 2-4.
- Checking **`Type something.`** alongside other options opens the free-text
  field with those ticks preserved, and the typed value is **appended** to them
  rather than replacing them, so `pi-stats, pi-plan-mode, and also the docs
  site` is a single answer.

Mutually exclusive choices stay single-select; that is still the default.

## Previews

An option may carry a `preview` field — markdown shown in a pane below the
options while that option is highlighted. Use it for concrete artifacts worth
comparing (ASCII mockups, code snippets, configuration variations), not for
simple preference questions. The pane is stacked rather than side-by-side, and
long previews are clipped with a `… N more lines` marker so the options always
stay visible.

**Why `n` and not `Tab` for notes?** Tab cycles questions here, matching
`@juicesharp/rpiv-ask-user-question`. `pi-auto-permissions` approval prompts
keep `Tab` for notes — they are single-question and have no tabs to cycle.

Every question gets an appended **`Type something.`** row for a free-text
answer. The model is not allowed to author that row itself — reserved labels
are rejected at runtime.

## Where the dialog renders

The questionnaire renders **in the editor area**, exactly where `ctx.ui.select`
puts pi's own selectors — not as an overlay floating over the transcript.

An overlay is composited over the bottom rows of the viewport, so the chat lines
underneath it are unreachable: you are already scrolled to the bottom and there
is nothing left to scroll. Rendering in the document flow pushes the transcript
up instead of covering it, so every line stays readable in the terminal's own
scrollback while you answer.

## No monkey patching

Numbered options and Tab-to-comment come from `OptionSelector`, imported from
[`@hank-warren/pi-permission-selector`](../pi-permission-selector) and rendered
through `ctx.ui.custom()`. pi exposes no `setSelectorComponent` hook, so the
only alternative would be patching pi's internal `ExtensionSelectorComponent` —
which this package deliberately avoids. The trade-off: consistent behavior
across the dialogs we own, and nothing to break when pi changes its internals.

## Subagents cannot use this tool

Whenever `ctx.hasUI` is false — which is every headless subagent child — the
tool is removed from the active tool set before the agent starts. A background
run can therefore never block waiting on a human, and a child can never route a
question up to its supervisor. This is intentional, not a limitation; see
[`reconcile.ts`](./reconcile.ts).

## Events

Other extensions can observe the questionnaire without touching this one:

```ts
pi.events.on("hank:ask-user:blocked", ({ active }) => {
  // active === true while a human is being asked
});
pi.events.on("hank:ask-user:prompt", ({ questions }) => {
  // questions[].question / .header / .multiSelect / .options[].label
});
```

Channel names are immutable and payloads are append-only — see
[`events.ts`](./events.ts) for the full stability policy.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
