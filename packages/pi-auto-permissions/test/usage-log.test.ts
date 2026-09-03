import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageRecord,
  buildUsageLogRecord,
  usageLogTotals,
  USAGE_LOG_ROTATE_BYTES,
  type UsageLogRecord,
} from "../usage-log.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "auto-permissions-usage-"));
  tempDirs.push(dir);
  return dir;
}

const piAiUsage = {
  input: 812,
  output: 96,
  cacheRead: 18_442,
  cacheWrite: 0,
  cacheWrite1h: 0,
  reasoning: 48,
  totalTokens: 19_350,
  cost: { input: 0.0024, output: 0.0014, cacheRead: 0.0083, cacheWrite: 0, total: 0.0121 },
};

test("normalizes pi-ai usage, including its nested cost total", () => {
  assert.deepEqual(usageLogTotals(piAiUsage), {
    input: 812,
    output: 96,
    cacheRead: 18_442,
    cacheWrite: 0,
    reasoning: 48,
    cost: 0.0121,
  });
  assert.deepEqual(usageLogTotals({ input: -5, cost: 0.5 }), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 0.5,
  });
  assert.deepEqual(usageLogTotals(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 });
});

test("records identity and counters only, never review content", () => {
  const record = buildUsageLogRecord("anthropic", "claude-fable-5", piAiUsage);
  assert.deepEqual(Object.keys(record).sort(), ["id", "label", "model", "provider", "source", "ts", "usage", "v"]);
  assert.equal(record.v, 1);
  assert.equal(record.source, "auto-permissions");
  assert.equal(record.label, "guardian");
  assert.equal(record.provider, "anthropic");
  assert.equal(record.model, "claude-fable-5");
  assert.notEqual(record.id, buildUsageLogRecord("anthropic", "claude-fable-5", piAiUsage).id);
  assert.ok(Number.isFinite(Date.parse(record.ts)));
});

test("appends private newline-delimited records", () => {
  const path = join(tempDir(), "nested", "usage.jsonl");
  const first = buildUsageLogRecord("anthropic", "claude-fable-5", piAiUsage);
  const second = buildUsageLogRecord("openai-codex", "gpt-5.6-sol", piAiUsage);
  appendUsageRecord(path, first);
  appendUsageRecord(path, second);

  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!) as UsageLogRecord, first);
  assert.deepEqual(JSON.parse(lines[1]!) as UsageLogRecord, second);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("tags subagent reviews and omits the field otherwise", () => {
  const tagged = buildUsageLogRecord("openai-codex", "gpt-5.6-luna", piAiUsage, "guardian", "auto-permissions", true);
  assert.equal(tagged.subagent, true);
  const untagged = buildUsageLogRecord("openai-codex", "gpt-5.6-luna", piAiUsage);
  assert.ok(!("subagent" in untagged), "non-subagent records must not carry the field");
});

test("rotates one generation once the sidecar grows past the cap", () => {
  const path = join(tempDir(), "usage.jsonl");
  writeFileSync(path, "x".repeat(USAGE_LOG_ROTATE_BYTES), "utf8");
  const record = buildUsageLogRecord("anthropic", "claude-fable-5", piAiUsage);
  appendUsageRecord(path, record);

  assert.ok(existsSync(`${path}.1`), "previous generation is retained for the reader");
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8").trim()) as UsageLogRecord, record);
});
