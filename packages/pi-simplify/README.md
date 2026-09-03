# @hank-warren/pi-simplify

A single-agent **simplify** skill for [Pi](https://github.com/earendil-works/pi): review recently changed code for clarity, consistency, and maintainability, then apply behavior-preserving improvements and run the focused tests that cover them.

This is a skill-only package — no extension code. Installing it registers one skill, `simplify`.

## Install

```bash
pi install npm:@hank-warren/pi-simplify
```

## Usage

Invoke it directly:

```
/skill:simplify                 # review tracked uncommitted changes (git diff HEAD)
/skill:simplify --staged        # review only the staged diff; edits stay unstaged
/skill:simplify --ref=main      # review changes since merge-base with main
/skill:simplify src/foo.ts      # restrict the review to given paths
```

Freeform scope instructions after the skill name are also honored ("only the parser changes", etc.).

Or delegate it: a parent agent can load this skill into one focused subagent and pass the target through the child's task prompt. The skill performs the whole review in a single agent and never spawns subagents itself.

## What it does — and refuses to do

- Applies **behavior-preserving** cleanups only, inside the changed line ranges of the selected diff: dead code, needless nesting and state, unclear names, duplicate logic, inconsistent patterns, compressed expressions.
- Reads project conventions (`AGENTS.md` / `CLAUDE.md`) before editing and runs the repository's focused tests afterwards.
- Never changes what the code does, never touches Git state (no staging, commits, stashes, resets), and never silently substitutes a different diff target when the requested scope is empty or ambiguous.

See [`simplify/SKILL.md`](simplify/SKILL.md) for the full workflow.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Attribution

Adapted from [`pi-simplify` 0.2.3](https://github.com/MattDevy/pi-extensions/tree/pi-simplify-v0.2.3/packages/pi-simplify) by Matt Devy under the MIT License. The workflow text was rewritten as a single-agent Pi skill. See [LICENSE](LICENSE).
