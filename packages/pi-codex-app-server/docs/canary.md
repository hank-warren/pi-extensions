# Live canary checklist

Unit tests here mock `ExtensionAPI` and drive the protocol over fake transports,
so they pin what this adapter *asks* Pi and a Codex client to do, never what they
*do*. This package's gap is wider than most: the other side of the wire is a
phone app nobody can mock honestly, and the daemon is a second process holding a
relay socket. Everything below is a state no test in `test/` can reach.

Run it before releasing anything that touches the daemon lifecycle, the model
catalogue, session writing, or the relay.

## Before you start

```bash
# a scratch agent dir cannot be used for the whole run: pairing and the model
# catalogue need the real ~/.pi/agent credentials. Use the real one, and expect
# the daemon to write ~/.pi/agent/codex-app-server/.
pi -e ./packages/pi-codex-app-server
```

Have the daemon's log in view in another pane; it is JSON lines on stderr.

## The extension half, in a real TUI

1. **Autostart stays off.** Starting the session must not spawn a daemon. Check
   before anything else: `pgrep -af pi-codex-app-server` is empty, and the footer
   shows no running endpoint. Upstream defaults this on; a session that quietly
   starts a relay-connected daemon is the regression.
2. **`/codex-server` status.** With nothing running it reports stopped, and
   reports it without starting anything. The subcommand completions offer
   `start`, `stop`, `status`, `pair`.
3. **Start and stop from the TUI.** `/codex-server start` waits for readiness and
   the footer shows `Codex server: running · ws://127.0.0.1:<port>`;
   `endpoint.json` exists with mode 600. `/codex-server stop` removes it and the
   footer clears. A stop that leaves the process alive is a release blocker.
4. **Pairing overlay.** `/codex-server pair` renders the QR code with the manual
   code beneath it and an expiry. `Esc` closes it and nothing is left on screen.
   Shrink the terminal below the QR's height and re-run: it must fall back to the
   manual code rather than draw a broken QR.

## The phone, against a running daemon

5. **The host appears.** ChatGPT app → Remote lists `oracle-vps-pi`, online, and
   exactly once. A second, offline entry means an older `state.sqlite` enrolled
   under a different server id.
6. **The picker is CPA-only.** Open the model list on the phone: every entry is a
   `cpa/` model, `cpa/claude-opus-5` is preselected, and no `plus/` or `team/`
   slug appears. Those are CPA's account-pinned aliases; offering them would take
   the account choice away from CPA's round-robin and quota failover.
7. **A thread and a turn.** Start a thread and send one prompt. The answer
   streams back on the phone. This is the whole point of the package and the one
   step that cannot be faked.
8. **The background helper does not error.** The app opens threads of its own
   with bare Codex slugs such as `gpt-5.4-mini`. The log must show the thread
   starting anyway (the slug resolves to the default model), not
   `Unknown Pi model`.
9. **Sessions come back to the TUI.** The thread started from the phone appears
   in Pi's own session list and resumes in the TUI with its history intact. The
   daemon borrows the host Pi install precisely so this holds; if it does not,
   the resolution hook is loading a different Pi than the TUI runs.
10. **Interrupt.** Stop a turn from the phone mid-stream. The turn ends, the
    daemon stays connected, and the next turn in the same thread still works.

## What the log has to show afterwards

11. **Method list.** Collect the `Relay client request` lines. Record the
    observed methods in
    [ADR 0021](adr/0021-stay-on-the-0.149-protocol-snapshot.md); they are the
    evidence for staying on the vendored protocol snapshot.
12. **No unexplained errors.** Zero `"level":"ERROR"` lines for the session. A
    method outside the vendored snapshot is fine and appears as a debug line plus
    a `-32601` to the client — note which ones, because a method the app actually
    depends on is the trigger to re-vendor.
13. **Reconnect.** Kill the relay socket (`ss -K src <daemon-socket>`) and watch
    it come back unattended: `relay disconnected` → at most a refused handshake
    with a doubled `reconnectDelay` → connected, within a few seconds.
