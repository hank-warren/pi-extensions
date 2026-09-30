# @hank-warren/pi-auto-name

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
