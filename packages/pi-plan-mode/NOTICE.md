# Attribution

This package is a fork of [`@narumitw/pi-plan-mode`](https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-plan-mode), version 0.49.3, from upstream commit `4c2c2e8c4b6c3d21659110ea1966810b1d15e045`.

The original work is Copyright (c) 2026 narumiruna and is used under the MIT License included in [`LICENSE`](LICENSE).

Fork-specific changes are Copyright (c) 2026 Hank Warren and are released under the same MIT License.

## Divergence from upstream

As of 1.0 this package has diverged substantially from upstream and no longer tracks it. Plan mode was rewritten around a durable plan file and no longer manages tool permissions: the tool selector, `defaultPlanTools`, the Bash inspection allowlist, `safeSubcommands`, the Auto Permissions Bash policy, the saved-plan state, and the plan-retention/context-reinjection machinery were all removed. Upstream changes are no longer merged.
