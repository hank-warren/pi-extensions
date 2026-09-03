# pi-extensions

A collection of [Pi](https://pi.dev) packages — a compact statusline, plan mode, a Bash permission guardian, long-running work loops, and more — published to npm under `@hank-warren/*`.

Every package stands on its own, so you can install just the one you want without taking the rest.

## Packages

Each package under [`packages/`](packages/) is a self-contained Pi package published to public npm and installable individually:

| Package | Description |
|---------|-------------|
| [`@hank-warren/pi-statusline`](packages/pi-statusline) | Compact footer statusline with model, git/worktree/PR state, context usage, and session ID |
| [`@hank-warren/pi-stats`](packages/pi-stats) | Theme-aware `/stats` dock for current, ranged, and all-time token usage across Pi and persisted subagent sessions, with model, tool, and project breakdowns |
| [`@hank-warren/pi-permission-selector`](packages/pi-permission-selector) | Library (no extension): the shared `OptionSelector` component — numbered options, digit hotkeys, inline notes, and checkbox multi-select — composed by pi-auto-permissions and pi-ask-user-question |
| [`@hank-warren/pi-auto-permissions`](packages/pi-auto-permissions) | Context-aware Bash guardian with tiered trust policy, denial/evaluation logs, revocable standing approvals, and a bundled interactive setup skill; forked from [`@ogulcancelik/pi-auto-permissions`](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-auto-permissions) |
| [`@hank-warren/pi-plan-mode`](packages/pi-plan-mode) | Plan mode for research and design, with a durable plan file that survives compaction and a companion `pi-plan-mode` skill loaded on demand |
| [`@hank-warren/pi-ask-user-question`](packages/pi-ask-user-question) | Structured questionnaire tool with numbered options, digit hotkeys, checkbox multi-select and Tab-to-comment; stripped from headless subagent runs |
| [`@hank-warren/pi-simplify`](packages/pi-simplify) | Skill-only package: single-agent `simplify` skill that applies behavior-preserving cleanups to recently changed code, adapted from [Matt Devy's `pi-simplify`](https://github.com/MattDevy/pi-extensions/tree/main/packages/pi-simplify) |
| [`@hank-warren/pi-multi-login`](packages/pi-multi-login) | Additional OAuth logins for built-in providers under aliased provider ids, managed with `/multi-login` |
| [`@hank-warren/pi-loop`](packages/pi-loop) | `/loop` long-running work: menu-first planning to an approval card with ground rules, settle-paced continuations, a durable on-disk ledger, loop-aware compaction with its own re-anchor, `loop_wait`, no-progress breakers, completion gated on cited evidence, and a companion `pi-loop` skill loaded on demand |
| [`@hank-warren/pi-stash`](packages/pi-stash) | Park an unsent prompt with `Ctrl+S`, run `/model` or anything else against an empty editor, then restore it with `Ctrl+S` — in-memory, paste-preserving, never submitted |

## Install

```bash
pi install npm:@hank-warren/<package-name>
```

Try one without installing it persistently:

```bash
pi -e npm:@hank-warren/<package-name>
```

See each package's README for setup and usage, and [AGENTS.md](AGENTS.md) for the repo layout, how to add a package, and the publish workflow. New packages start from [`docs/template-package/`](docs/template-package/).

Installing this repository as a git package loads every extension in `packages/`. Do not do that on a host that also installs the npm packages, or the extensions load twice.

## Highlights

### Plan Mode

The [`pi-plan-mode`](packages/pi-plan-mode) package started as a fork of `@narumitw/pi-plan-mode` 0.49.3 and has since diverged substantially. Plan mode is a mode of intent, not a permission system: it blocks `edit`, `write`, and `update_plan` while planning and leaves every other tool as configured, so command review stays with [`pi-auto-permissions`](packages/pi-auto-permissions). Completed plans are written to `~/.pi/agent/plans/<session-id>.md`; the model sees only a one-line pointer to that file, so plans survive compaction at negligible context cost and can be hand-edited. Paired with [`pi-ask-user-question`](packages/pi-ask-user-question), Plan mode asks its decision questions through that tool — previews, notes, question tabs, digit hotkeys and checkbox multi-select — and hides its own weaker `plan_mode_question`; standalone installs keep the built-in tool. See [`packages/pi-plan-mode/README.md`](packages/pi-plan-mode/README.md) for details.

### Statusline

The [`pi-statusline`](packages/pi-statusline) package replaces Pi's default footer with a compact statusline showing the active model, git branch/dirty/behind state, linked worktrees with PR numbers, context usage, and the full session ID. It uses a fixed true-color palette and configurable context warning thresholds. See [`packages/pi-statusline/README.md`](packages/pi-statusline/README.md) for the full rendering and worktree/PR tracking behavior.

### Auto Permissions

The [`pi-auto-permissions`](packages/pi-auto-permissions) package gates Bash calls through a guardian model review with a configurable policy. Its `guardian-transport.ts` is the seam that dispatches reviewer calls through the host `ModelRuntime`, so provider extensions apply to the reviewer too.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run scan-secrets
```

`npm test` is the whole gate: `scripts/validate.py` (package inventories, manifest shape, relative Markdown links, forbidden artifacts), shell and Python syntax sweeps, the typecheck, every test in the repository in a single hermetic `node --test` run, an extension load-and-registration smoke test, and Pi package discovery.

## Contributing

Issues and pull requests are welcome — bug reports, rough edges, and ideas for new packages all help.

This is a personal project maintained by one person, so a couple of expectations up front: `main` is maintainer-only, all changes land through pull requests from a fork, and I may be slow to respond or decline changes that pull a package away from how I use it day to day. None of that is meant to discourage you from opening something.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the details and [AGENTS.md](AGENTS.md) for repo layout and conventions.

## Publishing

Releases run on [changesets](https://github.com/changesets/changesets) via [`.github/workflows/publish.yml`](.github/workflows/publish.yml). Code pull requests intentionally carry **no changeset**: merge the code, run its live canary against merged `main`, and only then open a changeset-only release pull request:

```bash
npx changeset
```

Merging that release pull request to `main` is the whole release: the publish workflow versions the packages, commits the result back to `main`, publishes every package whose version is not yet on npm, and creates a GitHub release per package. Full conventions live in [AGENTS.md](AGENTS.md).
