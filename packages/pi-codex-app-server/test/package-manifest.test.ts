import { readFile } from "node:fs/promises";

import { z } from "zod";

import { describe, expect, it } from "./support/vitest-compat.ts";

const packageManifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()),
  peerDependencies: z.record(z.string(), z.string()),
  pi: z.object({ extensions: z.array(z.string()) }),
  bin: z.record(z.string(), z.string()),
});

const PI_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

describe("package manifest", () => {
  it("takes the Pi runtime from the host as peer dependencies, never a private copy", async () => {
    // Upstream installs its own pi-coding-agent. This fork resolves pi's packages
    // from the host install (bin/pi-resolve-hooks.ts) so the daemon runs the same
    // pi as the TUI that later resumes its sessions.
    const manifestContents = await readFile(
      new URL("../package.json", import.meta.url),
      "utf-8"
    );
    const manifest = packageManifestSchema.parse(JSON.parse(manifestContents));

    for (const name of PI_PACKAGES) {
      expect(manifest.peerDependencies[name]).toBe("*");
      expect(manifest.dependencies[name]).toBeUndefined();
    }
    expect(manifest.pi.extensions).toStrictEqual(["./index.ts"]);
    expect(manifest.bin["pi-codex-app-server"]).toBe("./bin/pi-codex-app-server.ts");
  });
});
