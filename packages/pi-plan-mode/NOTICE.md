# Attribution

This package is a fork of [`@narumitw/pi-plan-mode`](https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-plan-mode), version 0.49.3, from upstream commit `4c2c2e8c4b6c3d21659110ea1966810b1d15e045`.

The original work is Copyright (c) 2026 narumiruna and is used under the MIT License included in [`LICENSE`](LICENSE).

Fork-specific changes are Copyright (c) 2026 Hank Warren and are released under the same MIT License.

## Design influences for the revision store

The revision store added for `update_plan` (`src/revision-store.ts`) is original work. **No source is copied into it.** It is recorded here because the durable-storage discipline borrows from two places, and a reader comparing them should know which decisions came from where.

- [`minhduydev/pi-todo`](https://github.com/minhduydev/pi-todo) was reviewed as the reference for durable file storage: `proper-lockfile`, SHA-256 content checks, and temp-file-plus-rename publication. This package uses the same three techniques and the same dependency. One correction is carried deliberately: that store compares its hash *before* the awaited create/write/fsync/rename sequence, which detects a cooperating writer but is **not** a compare-and-swap against a writer that ignores the lock. This package makes the weaker, accurate claim — the digest turns an outside modification into a detected conflict at the next read, resolved by a person, and every published revision is retained under `revisions/`. See the README.
- The sibling [`@hank-warren/pi-tasks`](../pi-tasks) solves the same problem for task documents. The reserve/prepare/publish/finalize ordering and the lock-lease handling follow its `src/store.ts` in shape, reimplemented here for a manifest-indexed single document rather than copied, so neither is registered in `DUPLICATED_SOURCES`.

## Divergence from upstream

As of 1.0 this package has diverged substantially from upstream and no longer tracks it. Plan mode was rewritten around a durable plan file and no longer manages tool permissions: the tool selector, `defaultPlanTools`, the Bash inspection allowlist, `safeSubcommands`, the Auto Permissions Bash policy, the saved-plan state, and the plan-retention/context-reinjection machinery were all removed. Upstream changes are no longer merged.

Upstream had a tool named `update_plan` in its pre-1.0 line; the `update_plan` in this package is unrelated to it and shares no code or contract with it.

## Plan/task bridge

`src/plan-contract.ts` is original MIT-licensed work, Copyright (c) 2026 Hank Warren, duplicated byte-for-byte in `pi-tasks` and `pi-plan-mode` and checked by `DUPLICATED_SOURCES`. Neither extension imports or depends on the other's source. The bridge and reconciliation implementation copy no external donor code.

## Runtime dependencies

- [`@narumitw/pi-tui-kit`](https://www.npmjs.com/package/@narumitw/pi-tui-kit) — MIT, Copyright (c) 2026 narumiruna.
- [`proper-lockfile`](https://www.npmjs.com/package/proper-lockfile) — MIT, Copyright (c) 2018 Made With MOXY Lda.
