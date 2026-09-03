# @hank-warren/pi-stash

## 0.3.0

### Minor Changes

- 12b7e7a: Move the stash shortcut from `Ctrl+S` to `Alt+S`, and make it configurable.

  **The key changed.** `Ctrl+S` was never free: Pi binds it twice in its built-in map, to `app.models.save` and `app.session.toggleSort`, so pi-stash printed a shortcut-conflict warning at every startup. Rebinding either built-in only re-pointed the warning at the other. `Alt+S` is clear of every built-in, keeps the mnemonic, and reaches Pi as `ESC`+`s` — unlike `Ctrl+Shift+<letter>`, which terminals without the kitty keyboard protocol cannot tell apart from `Ctrl+<letter>`.

  No default is right on every host, though, since collisions depend on which extensions and keybindings you load. Set the key in `<agent dir>/pi-stash.json`:

  ```json
  { "shortcut": "ctrl+shift+p" }
  ```

  Use `"off"` to register no shortcut at all, leaving the key to whatever else wants it. Unknown fields are rejected rather than silently ignored, and an unreadable or invalid file falls back to `Alt+S` and reports why on first use — an unusable preference is a smaller failure than an extension that will not load.

  Everything else is unchanged: stashes still live only in memory, restoring still never submits, and large pastes still round-trip through Pi's paste handling.

## 0.2.0

### Minor Changes

- 50599a5: Add pi-stash: park an unsent prompt with `Ctrl+S`, run `/model` or anything else against an empty editor, then press `Ctrl+S` on the empty editor to pick a stash and restore it — still editable, still unsent.

  One shortcut with two modes, chosen by whether the editor holds substantive text. Stashes accumulate with no cap and list newest first, each with a `#<id>` prefix, a bounded single-line preview, and line and character counts, so two identical drafts stay distinguishable. Cancelling loses nothing; restoring consumes exactly the one stash. A large paste is stashed with its expanded body rather than the `[paste #N …]` placeholder and comes back through Pi's own paste handling, so it collapses to a marker again instead of flooding the editor.

  Stashes live in the loaded extension's memory and are written nowhere — not to session JSONL, settings, or any other file. They survive a model change, and are discarded by `/reload`, session replacement, and process exit.

  Pi binds `ctrl+s` to `app.models.save`, so a benign shortcut-conflict warning appears at startup; `Ctrl+S` inside the model picker still sets the default model, and the stash shortcut acts only in the main editor.
