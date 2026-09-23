import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** Rotate once a sidecar grows past this size; one previous generation is kept. */
export const SIDECAR_ROTATE_BYTES = 16 * 1024 * 1024;

function rotateIfLarge(path: string, rotateBytes: number): void {
  try {
    if (statSync(path).size < rotateBytes) return;
    renameSync(path, `${path}.1`);
  } catch {
    // A missing or unrotatable sidecar simply keeps appending.
  }
}

/** Append one JSON line to an owner-only sidecar, rotating first when `rotateBytes` is set. */
export function appendJsonlRecord(path: string, record: unknown, rotateBytes?: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (rotateBytes !== undefined) rotateIfLarge(path, rotateBytes);
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}
