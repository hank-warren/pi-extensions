# permission-selector

`OptionSelector` — a composable [pi](https://github.com/earendil-works/pi) TUI
selector with numbered options, digit hotkeys, inline notes, and an opt-in
checkbox multi-select mode.

This is a **library package**, not an extension: it registers nothing when
installed and exists to be imported by sibling packages through plain npm
`dependencies`. It is the selector behind:

- `@hank-warren/pi-auto-permissions` — command approval prompts (`Allow` /
  `Block`), rendered through `ctx.ui.custom()` with Tab-to-comment.
- `@hank-warren/pi-ask-user-question` — the `ask_user_question` questionnaire,
  which rebinds the note key to `n` so Tab can cycle question tabs.

> **History:** through `0.3.x` this package was an extension that
> monkey-patched pi's internal `ExtensionSelectorComponent` to add numbering
> and Tab-to-comment to *every* `ctx.ui.select` dialog. That patch is gone:
> `pi-auto-permissions` now composes `OptionSelector` directly, so nothing
> here touches dialogs owned by other code. If you install this package on its
> own, it does nothing.

## What `OptionSelector` provides

```
→ 1. Allow, after this command runs, check the logs▌
  2. Block
  enter submit · esc discard note · tab back
```

- Numbered options (`1. Allow`, `2. Block`, …) with `1`–`9` instant-select
  hotkeys; options beyond the ninth are arrow-only.
- `↑↓` navigation, Enter to confirm, Esc to cancel.
- An inline note editor (Tab by default, configurable via `commentTrigger`):
  Enter submits the highlighted option *plus* the trimmed note; Esc discards
  the note only; Tab toggles back preserving typed text. Digits are literal
  text while typing, bracketed paste works (multi-chunk included, flattened to
  one line), and rows wrap instead of overflowing narrow dialogs.
- Key handling is encoding-aware via pi-tui's `matchesKey`, so Kitty keyboard
  protocol terminals (Esc = `\x1b[27u`, CSI-u printables) behave the same as
  legacy encodings.

## Multi-select

Set `multiSelect: true` and supply `onSubmit` instead of `onSelect`:

```
→ [x] 1. pi-stats
  [ ] 2. pi-statusline
  [x] 3. pi-plan-mode
  space/1-9 toggle · ↑↓ move · enter confirm (2) · tab add note · esc cancel
```

- Space and `1`–`9` both toggle the row; a digit also moves the highlight and
  no longer commits, so one keystroke can never end the question early.
- Enter calls `onSubmit(checked, comment?)` with the checked options in list
  order. With nothing checked it is inert — the `(0)` in the hint is the tell.
- Everything else is unchanged: Esc cancels, the note editor still opens on the
  configured trigger and its text arrives as `onSubmit`'s `comment`, and rows
  wrap and indent under the label with the checkbox accounted for.
- `getChecked()` exposes the current selection to hosts and tests.

Every option is optional and inert unless `multiSelect` is set, so single-select
callers are byte-for-byte unchanged.

## Usage

```ts
import { OptionSelector } from "@hank-warren/pi-permission-selector/selector.ts";

const choice = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) =>
	new OptionSelector({
		title: "Deploy — needs approval",
		options: [
			{ value: "Allow", label: "Allow" },
			{ value: "Block", label: "Block" },
		],
		theme,
		onSelect: (option, comment) => done(option.value),
		onCancel: () => done(undefined),
		requestRender: () => tui.requestRender(),
	}),
);
```

`keys.ts` exports the underlying pure key predicates and the comment-mode
state machine for callers that need to compose their own input handling (the
questionnaire dialog does).

## Stability

`keys.ts` and `selector.ts` are a frozen cross-package contract: sibling
packages deep-import them from the published tarball, so renames, removed
exports, or dropping either file from the `files` allowlist break consumers at
runtime. `test/shared-surface-contract.test.ts` guards this.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.
