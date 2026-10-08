# @hank-warren/pi-auto-name

## 0.3.0

### Minor Changes

- Keep the session name current: rename on the first settled turn and every second turn after (1, 3, 5, …).

  Automatic renames only replace a name the extension set itself, recorded in a `pi-auto-name` custom entry so ownership survives resume and fork; a name set with `/name` is left alone until `/rename` hands it back. An unchanged title writes nothing, and a failed attempt is retried on the next odd turn.

## 0.2.0

### Minor Changes

- Report the session name to Herdr as the pane token `$session_name`.

  Inside a Herdr pane, the session name is now reported as display-only pane metadata, so a Herdr sidebar row can show just the name instead of pi's `π - <name> - <dir>` terminal title:

  ```toml
  [ui.sidebar.agents]
  rows = [
    ["workspace", "state_icon", { token = "state_text", dim = true }],
    [{ token = "$session_name", dim = true }],
  ]
  ```

  The token follows every name change (the automatic name, `/rename`, `/name`, resumed and forked sessions), is cleared for an unnamed session, and is cleared when pi quits. Each report is one short socket write with a 500 ms timeout, and failures are ignored. Outside Herdr or the interactive TUI nothing is sent. With `herdr --remote`, add the row to the client's local Herdr config.
