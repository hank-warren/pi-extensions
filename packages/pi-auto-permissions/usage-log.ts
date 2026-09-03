import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/** Rotate once the sidecar grows past this size; one previous generation is kept. */
export const USAGE_LOG_ROTATE_BYTES = 16 * 1024 * 1024;

interface UsageLogTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
}

/**
 * One model call recorded outside the Pi session transcript. The record is deliberately
 * content free: it carries identity, timing, and counters only, never prompts, commands,
 * evidence, or responses.
 */
export interface UsageLogRecord {
  v: 1;
  id: string;
  ts: string;
  source: string;
  label: string;
  provider: string;
  model: string;
  /** Present (true) only for reviews issued inside a subagent child session. */
  subagent?: true;
  usage: UsageLogTotals;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Normalize a pi-ai usage payload, whose cost is an object with a total. */
export function usageLogTotals(usage: unknown): UsageLogTotals {
  const record = (usage && typeof usage === "object" ? usage : {}) as Record<string, unknown>;
  const cost = (record.cost && typeof record.cost === "object" ? record.cost : {}) as Record<string, unknown>;
  return {
    input: count(record.input),
    output: count(record.output),
    cacheRead: count(record.cacheRead),
    cacheWrite: count(record.cacheWrite),
    reasoning: count(record.reasoning),
    cost: count(typeof record.cost === "number" ? record.cost : cost.total),
  };
}

export function buildUsageLogRecord(
  provider: string,
  model: string,
  usage: unknown,
  label = "guardian",
  source = "auto-permissions",
  subagent = false,
): UsageLogRecord {
  return {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    source,
    label,
    provider,
    model,
    ...(subagent ? { subagent: true as const } : {}),
    usage: usageLogTotals(usage),
  };
}

function rotateIfLarge(path: string): void {
  try {
    if (statSync(path).size < USAGE_LOG_ROTATE_BYTES) return;
    renameSync(path, `${path}.1`);
  } catch {
    // A missing or unrotatable sidecar simply keeps appending.
  }
}

export function appendUsageRecord(path: string, record: UsageLogRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rotateIfLarge(path);
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}
