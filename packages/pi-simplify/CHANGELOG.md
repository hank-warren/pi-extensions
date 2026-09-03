# @hank-warren/pi-simplify

## 0.2.0

### Minor Changes

- 81567a9: Initial release: a skill-only pi package carrying the single-agent `simplify` skill.

  The skill reviews recently changed code (working tree, `--staged`, `--ref=<ref>`, explicit paths, or freeform scope) and applies behavior-preserving cleanups inside the changed line ranges only, then runs the focused tests that cover the edits. It never touches Git state and never spawns subagents — a parent agent can load it into one focused child instead.

  Adapted from Matt Devy's `pi-simplify` 0.2.3 under the MIT License, rewritten as a single-agent Pi skill.

  This is also the repository's first skill-only package: `scripts/validate.py` now validates skill packages (skills-only `pi` manifest, SKILL.md frontmatter name matching its directory, no code or dependencies, files allowlist coverage) and derives the root `pi.skills` re-export list from every skill package, failing on drift in either direction.
