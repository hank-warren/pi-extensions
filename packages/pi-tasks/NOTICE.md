# Attribution

This package is original work, Copyright (c) 2026 Hank Warren, released under the MIT License in [`LICENSE`](LICENSE). **No source from the projects below is copied into it.** They are recorded here because the design borrows from them, and because a reader comparing the two should know which decisions came from where.

## Design influences

### oh-my-pi

[`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi), inspected at commit `70fdd40e2c4883f3f8544de4e377a6854eea78f8`, MIT License (Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük; Copyright (c) 2026 Stencil Labs, Inc.).

Adopted, as design rather than as code:

- the phased task list with five execution states, and the `[ ] [/] [x] [-] [!]` Markdown status vocabulary;
- the single-batch operation shape for a checklist tool.

Deliberately **not** adopted, and reversed here:

- content as identity. `oh-my-pi` matches tasks by their text; this package allocates `p*`/`t*` ids that are never reused, so a reworded task keeps its history.
- automatic promotion of the first pending task to in-progress. Starting work is explicit.
- destructive re-initialization. `init` refuses to replace an attached set.
- implicit demotion when a second task starts. That refuses instead.

The UX vocabulary was also ported to Pi independently by [`code-yeongyu/pi-todotools`](https://github.com/code-yeongyu/pi-todotools), which was reviewed as prior art for how these concepts land in a Pi extension.

### minhduydev/pi-todo

[`minhduydev/pi-todo`](https://github.com/minhduydev/pi-todo) was reviewed as the reference for durable file storage: `proper-lockfile`, SHA-256 content checks, and temp-file-plus-rename publication. This package uses the same three techniques and the same dependency.

One correction is carried deliberately. That store compares its hash *before* the awaited create/write/fsync/rename sequence, which detects a cooperating writer but is not a compare-and-swap against a writer that ignores the lock. This package makes the weaker, accurate claim: the digest turns an outside modification into a detected conflict at the next read, resolved by a human through `/tasks recover`, and every accepted revision is retained under `revisions/`. See the README.

Its subagent integration was **not** adopted. It targets `@minhduydev/pi-core` task-lifecycle events, which are not the events `nicobailon/pi-subagents` emits; treating them as interchangeable would produce completion signals that never arrive.

### Sibling packages in this repository

The durable-file discipline (same-directory temp file, atomic rename, per-path serialization, refusing a symlink or a non-regular file, a size cap) follows `@hank-warren/pi-plan-mode`'s `plan-file.ts`, and the one-formatter-two-surfaces rule for the widget and footer follows its `presentation.ts`. Both were reimplemented for this package's different shape rather than copied, so neither is registered in `DUPLICATED_SOURCES`.

## Runtime dependencies

- [`proper-lockfile`](https://www.npmjs.com/package/proper-lockfile) — MIT, Copyright (c) 2018 Made With MOXY Lda.
- [`@narumitw/pi-tui-kit`](https://www.npmjs.com/package/@narumitw/pi-tui-kit) — MIT, Copyright (c) 2026 narumiruna.
