import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonlRecord } from "../jsonl-sidecar.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-ap-sidecar-"));
  tempDirs.push(dir);
  return dir;
}

test("rotates one generation once the file reaches the threshold", () => {
  const path = join(tempDir(), "log.jsonl");
  const old = `${"x".repeat(70)}\n`;
  writeFileSync(path, old, "utf8");
  appendJsonlRecord(path, { n: 1 }, 64);

  assert.equal(readFileSync(`${path}.1`, "utf8"), old);
  assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({ n: 1 })}\n`);
});

test("a file below the threshold is not rotated", () => {
  const path = join(tempDir(), "log.jsonl");
  writeFileSync(path, "small\n", "utf8");
  appendJsonlRecord(path, { n: 1 }, 64);

  assert.ok(!existsSync(`${path}.1`));
  assert.equal(readFileSync(path, "utf8"), `small\n${JSON.stringify({ n: 1 })}\n`);
});

test("without a threshold a large file is never rotated", () => {
  const path = join(tempDir(), "log.jsonl");
  const old = "x".repeat(4096);
  writeFileSync(path, old, "utf8");
  appendJsonlRecord(path, { n: 1 });

  assert.ok(!existsSync(`${path}.1`));
  assert.equal(readFileSync(path, "utf8"), `${old}${JSON.stringify({ n: 1 })}\n`);
});

test("creates a private file in a private nested directory", () => {
  const parent = join(tempDir(), "nested");
  const path = join(parent, "log.jsonl");
  appendJsonlRecord(path, { n: 1 }, 64);

  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(parent).mode & 0o777, 0o700);
});

test("a missing file with a threshold just appends", () => {
  const path = join(tempDir(), "log.jsonl");
  appendJsonlRecord(path, { n: 1 }, 64);

  assert.ok(!existsSync(`${path}.1`));
  assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({ n: 1 })}\n`);
});
