---
"@hank-warren/pi-statusline": minor
---

Add custom items: user-defined command segments rendered after the usage meters.

Each entry in the new `customItems` setting runs a shell command, hands it JSON
about the session on stdin, and renders the first line of its stdout as a
statusline segment — the same contract Claude Code's `statusLine` uses, so a
script written for it ports over. Items refresh at session start, at each turn
end, and on an optional `refreshInterval` timer; one run per item at a time,
with a timeout, a failure grace period before a stale value is dropped, and
output sanitized to SGR colors so a command cannot corrupt the frame.

`/statusline` gains a **Custom items** toggle and a **Custom item list** submenu
that enables or disables each item and shows why one is not rendering. Commands
stay in the settings file, and entries this version cannot parse — an unknown
`type`, an unrecognised key — are preserved verbatim on write rather than
dropped, so toggling an unrelated setting can never delete a configured item.
