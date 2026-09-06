---
"@hank-warren/pi-loop": minor
---

Deprecated in favour of `@hank-warren/pi-orchestrator`.

pi-loop is a pacemaker for one session that cannot be trusted to pace itself. The
`pi-orchestrator` skill is a supervising pi session watching real pi sessions in
Herdr panes — reading their state, answering their prompts within policy,
steering, and verifying their claims — which does by judgment what the loop
engine did by pacing and gates. This package stays published and continues to
work; it is no longer loaded by the git install of the `pi-extensions`
repository and receives no new features. The README opens with the notice.
