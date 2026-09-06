---
"@hank-warren/pi-loop": minor
"@hank-warren/pi-plan-mode": minor
---

Ship the craft documents by injected path instead of as skills.

The `pi-loop` and `pi-plan-mode` skills are gone. Their bodies now ship as
`docs/loop-craft.md` and `docs/plan-craft.md`, and the mode prompts inject the
file's absolute path (resolved from the installed package) at the moments the
guidance matters: while a loop is being drafted or completed, and while Plan
Mode is active. A skill's description line sits in every system prompt of every
session with the package loaded; across ~220 sessions after these two shipped,
every read of either file was triggered by the mode's own prompt and never by
the description, so the line was a tax on the ~95% of sessions that never
entered the mode. Same document, read at the same moments, at zero cost outside
them. Hosts that referenced the skills by name in settings should drop those
entries.
