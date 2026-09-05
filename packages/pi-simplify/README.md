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

## Gates

Those refusals used to be promises the model kept by discipline. Most of them are now checked, and the check's output is part of the report the skill must emit — a gate whose transcript is the deliverable cannot be quietly skipped. A behaviour-preserving refactor is exactly the change existing tests are least likely to catch, since they were written against the old shape, so a green suite on its own proves only what its author thought to test.

Checked mechanically, after the edits, against a snapshot taken before them:

- **Range gate** — every hunk in the new diff sits inside a hunk of the original diff (compared on the `HEAD`-anchored side, so it survives line-count changes, with a ±3-line tolerance for Git re-anchoring). A file that was not in the original diff fails, and any changed test file fails outright: a simplify pass that edits tests is redefining behaviour.
- **Baseline gate** — the same focused test command runs before and after; the run must exit 0 *and* report the same set of passing test names, so a test that silently stopped running is caught. A red baseline gates on no new failures, never on green; no test command at all is reported as `none` and the pass is labelled unverified rather than ok.
- **Git gate** — `HEAD`, stash count, the index, and the added/deleted/untracked file sets must be unchanged.

Still judgment, and deliberately so: **equivalence**. No test proves a refactor behaviour-preserving, so the skill must write one line per simplified hunk naming the input that would tell the two versions apart — or "no input", earned by saying what it checked. Any other answer labels the pass *behaviour-changing — not a simplification* in the first line of the summary.

A failed gate never reverts anything (that would touch Git state, which is itself gated) and never passes silently: the skill reports the failure with its output and leaves its edits in the working tree, labelled as not passing, for you to inspect.

See [`simplify/SKILL.md`](simplify/SKILL.md) for the full workflow, including the exact gate commands.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Attribution

Adapted from [`pi-simplify` 0.2.3](https://github.com/MattDevy/pi-extensions/tree/pi-simplify-v0.2.3/packages/pi-simplify) by Matt Devy under the MIT License. The workflow text was rewritten as a single-agent Pi skill. See [LICENSE](LICENSE).
