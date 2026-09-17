#!/usr/bin/env node
// Standalone entry for the daemon and CLI, run straight from TypeScript source
// (Node >= 22.18 strips types; no build step). It aliases pi's packages to the
// host install before loading the CLI, so `pi` must be on PATH or
// PI_CODEX_APP_SERVER_PI_ROOT must point at its package directory.
import { register } from "node:module";

import { resolvePiRoot } from "./pi-root.ts";

register("./pi-resolve-hooks.ts", import.meta.url, {
  data: { piRoot: resolvePiRoot() },
});

await import("../src/cli.ts");
