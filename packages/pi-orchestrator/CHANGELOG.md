# @hank-warren/pi-orchestrator

## 0.1.0

### Minor Changes

- 1035138: First release: a skill for supervising first-class pi sessions in Herdr panes.

  One skill, `pi-orchestrator`, carrying the doctrine for a pi session that
  launches other pi sessions as real TUI agents in tabs of its Herdr workspace and
  supervises them: a cost ladder for reading state (`herdr agent get` before any
  screen read; the session JSONL for what a child actually ran), what each Herdr
  status means and what to do, a bounded policy for answering Auto Permissions
  prompts in the human's place (approve only a command inside the task that the
  supervisor would run itself under the same ground rules; otherwise block with a
  comment that steers; never a standing approval; never argue a deny rule; every
  decision written down and reported), waiting through the `process` tool rather
  than sleeping, and verification as the gate — a child saying it is done is a
  claim the supervisor re-checks before repeating. Requires the `herdr` CLI and
  `HERDR_ENV=1`; children should run pi-auto-permissions, pi-ask-user-question
  and pi-plan-mode recent enough to report `blocked` to Herdr.
