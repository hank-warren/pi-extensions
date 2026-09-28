# @hank-warren/pi-thinking-step

Step the thinking level up or down one notch with **Alt+=** and **Alt+-**, instead of cycling through every level with Shift+Tab to get back to the one below.

## Install

```bash
pi install npm:@hank-warren/pi-thinking-step
```

Try it without installing:

```bash
pi -e npm:@hank-warren/pi-thinking-step
```

## Usage

| Key | Action |
|-----|--------|
| Alt+= | Thinking level up (`=` shares a key with `+`) |
| Alt+- | Thinking level down |

Levels run `off → minimal → low → medium → high → xhigh → max`.

- **Unsupported levels are skipped.** Pi clamps a requested level to what the current model supports, and the shortcut keeps stepping until the effective level actually changes. A model without `minimal` goes straight from `low` to `off`; one with `max` but not `xhigh` goes straight from `high` to `max`.
- **No wrap-around.** At the model's top or bottom level the key does nothing and says so: `Thinking: high (limit)`. A non-reasoning model only has `off`.
- **Session only.** Like Shift+Tab, a step changes the current session. Pi's `Ctrl+S` still saves the current level as the default.

## Terminal setup

The keys are Alt (Meta) chords. On macOS the terminal must send Option as Meta, or Option+= types `≠` and Option+- types `–`:

- Terminal.app: Settings → Profiles → Keyboard → "Use Option as Meta key"
- iTerm2: Settings → Profiles → Keys → Left/Right Option key → "Esc+"
- Ghostty: `macos-option-as-alt = true`

Check `/hotkeys` for the Extensions section to confirm both keys are registered.
