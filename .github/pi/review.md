# Review guidance for pi-extensions

Public pi packages under `packages/`, each published to npm as `@hank-warren/pi-*` and loaded by pi
as TypeScript with no build step. `AGENTS.md` is the source of truth for the rules below; read it.

Blocking, in this repo:

- **Runtime breakage in a loaded extension.** An import that does not resolve from the published
  package (a relative path into a sibling package, a file missing from the package's `files`
  allowlist, a pi API used with the wrong shape), or an exception on load or on a session event.
- **Session-lifecycle and delivery bugs.** Messages that never dispatch, `Esc` no longer
  interrupting a turn, state lost across `--continue`, a tool or widget not restored on resume.
- **Permission or secret leaks.** `pi-auto-permissions` approving something it should prompt for, a
  credential or token written to a file, log, or session entry, or a test that touches the real
  `~/.pi/agent`.
- **Release mechanics.** Hand-edited package versions (not written by `npm run version-packages`),
  a `.changeset/*.md` left unapplied, or a new package missing from `scripts/validate.py`, the
  root `package.json` manifest, `scripts/smoke-load.mjs` or `package-lock.json`. A code PR may
  carry its own applied version bump when its description records a live canary of the PR
  branch (see "Release in the pull request, or hold the changeset" in `AGENTS.md`); a bump in a
  code PR whose description records no canary is blocking. Judge whether a canary is recorded,
  not whether it was thorough enough.
- **Duplicated sources drifting.** A file listed in `DUPLICATED_SOURCES` changed in one copy only.

Not blocking: README wording, test style, comment phrasing, refactors that keep behavior.
