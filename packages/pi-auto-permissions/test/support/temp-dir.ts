/**
 * Scratch directories for package tests. Every directory is removed after
 * EVERY test, so never create one at module scope or in before() and share it
 * across tests.
 */
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Already gone or never restricted; removal below still runs.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

export function scratchDir(prefix = "pi-ap-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
