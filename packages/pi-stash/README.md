# @hank-warren/pi-stash

Park an unsent prompt with **Alt+S**, do something else in the empty editor, then press **Alt+S** again to get it back.

The case it exists for: you have typed — or pasted — a long prompt, and then realise you want a different model first. Running `/model` means losing the draft or juggling it in another window. With pi-stash, Alt+S puts the draft aside, `/model` runs against an empty editor, and Alt+S brings the draft back exactly as it was, still unsent.

## Install

```bash
pi install npm:@hank-warren/pi-stash
```

Try it without installing:

```bash
pi -e npm:@hank-warren/pi-stash
```

## Usage

One key, two modes, chosen by what the editor holds:

| Editor | Alt+S |
|--------|-------|
| Has text | Stashes it and clears the editor |
| Empty or whitespace only | Opens a selector of stashes, newest first |

- **Multiple stashes.** Press Alt+S on several drafts and they all accumulate; there is no cap and nothing is silently evicted. The selector lists them newest first, each with a `#<id>` prefix, a one-line preview, and line and character counts — so two identical drafts stay tellable apart.
- **Cancel is safe.** `Esc` in the selector leaves every stash untouched.
- **Restoring consumes one stash.** The selected draft returns to the editor and leaves the list; the others stay.
- **Restoring never submits.** No Enter is synthesized and no message is sent — the prompt comes back editable, exactly as you left it.
- **Pastes stay compact.** A large paste is stashed with its full body, not the `[paste #N …]` placeholder, and comes back through Pi's own paste handling — so the editor shows a compact marker again rather than a thousand lines.

## Lifetime

Stashes live in memory for the loaded extension runtime and are written nowhere: not to session JSONL, not to settings, not to a log or any other file. An unsent prompt never reaches disk.

They survive a model change, which is the whole point. They are discarded by `/reload`, by session replacement (`/new`, `/resume`, `/fork`), and by process exit.

## Changing the key

`Alt+S` is the default because it collides with no built-in Pi keybinding, and because it reaches Pi as `ESC`+`s` — unlike `Ctrl+Shift+<letter>`, which terminals without the kitty keyboard protocol cannot distinguish from `Ctrl+<letter>` at all.

A collision is a property of your host rather than of this package, though: your own `keybindings.json` and every other extension you load compete for the same small space. Set the key in `<agent dir>/pi-stash.json` (usually `~/.pi/agent/pi-stash.json`):

```json
{ "shortcut": "ctrl+shift+p" }
```

Use `"off"` to register no shortcut at all, leaving the key to whoever else wants it. An unreadable or invalid file falls back to `Alt+S` and says so the first time you press it, rather than failing to load.

If Pi prints `Extension shortcut conflict` naming pi-stash at startup, that is this setting's cue: something else on your host already claims the key.

## Scope

Text prompts only. Image attachments, cursor position, cross-session sharing, disk persistence, and naming or deleting stashes outside the selector are out of scope.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
