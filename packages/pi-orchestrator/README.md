# @hank-warren/pi-orchestrator

A **pi-orchestrator** skill for [Pi](https://github.com/earendil-works/pi): let one pi session supervise other pi sessions running as real TUI agents in [Herdr](https://herdr.dev) panes — launch them, read their state without bloating context, detect when one is waiting on a human, answer Auto Permissions and question prompts within a bounded policy, steer, wait, verify their claims, and report.

This is a skill-only package — no extension code. Installing it registers one skill, `pi-orchestrator`. It requires the `herdr` CLI and a session running inside Herdr (`HERDR_ENV=1`); outside Herdr the skill says so and stops.

## Install

```bash
pi install npm:@hank-warren/pi-orchestrator
```

## Usage

```
/skill:pi-orchestrator
```

or ask in plain words — "orchestrate this across two pi sessions", "supervise a child doing X in herdr". The orchestrating session should be a strong model; the children run whatever the host's default is unless the task says otherwise.

## What it does, and what it deliberately does not

The children are first-class pi sessions with the full extension set a human's session has, in panes a human can click into. Every primitive the supervisor uses already exists: `herdr agent get / read / prompt / send-keys / wait`, the `herdr:blocked` signal that [pi-auto-permissions](../pi-auto-permissions), [pi-ask-user-question](../pi-ask-user-question) and [pi-plan-mode](../pi-plan-mode) emit while waiting on a person, and the digit hotkeys and Tab-to-comment on their dialogs. The skill is the doctrine for using them:

- **A cost ladder for reading state** — `agent get` (a few hundred bytes) before any screen read; `visible` only on a state change; the session JSONL for what the child actually ran.
- **What each Herdr status means** and what to do — a `blocked` with a gate label is an approval, `question` / `plan question` is a dialog, `idle` with the plan-ready footer is a finished plan waiting on `/plan`.
- **A bounded policy for answering Auto Permissions in the human's place** — approve only a command that is inside the task *and* that the supervisor would run itself under the same ground rules; otherwise block with a Tab-comment that steers; never a standing approval; never argue a deny rule; every decision written down and reported.
- **Waiting through the `process` tool**, never by sleeping in the supervisor's own shell.
- **Verification as the gate** — a child saying it is done is a claim; the supervisor re-runs the named checks itself before repeating it.

It does not start loops, schedule wakeups, or keep a ledger. It replaces [pi-loop](../pi-loop), whose pacing and evidence gate approximated for a single unsupervised session what a supervising model does by judgment.

## Requirements

- Herdr with its pi integration installed (`herdr integration`), so a child's lifecycle is reported through hooks rather than screen detection.
- A pi with the [`process`](https://www.npmjs.com/package/@aliou/pi-processes) tool or equivalent for background waits.
- Children on a recent [pi-auto-permissions](../pi-auto-permissions), [pi-ask-user-question](../pi-ask-user-question) and [pi-plan-mode](../pi-plan-mode) so every human-waiting dialog reports `blocked`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
