import { randomUUID } from "node:crypto";
import { appendJsonlRecord, SIDECAR_ROTATE_BYTES } from "./jsonl-sidecar.js";

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
  subagent = false,
): UsageLogRecord {
  return {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    source: "auto-permissions",
    label,
    provider,
    model,
    ...(subagent ? { subagent: true as const } : {}),
    usage: usageLogTotals(usage),
  };
}

export function appendUsageRecord(path: string, record: UsageLogRecord): void {
  appendJsonlRecord(path, record, SIDECAR_ROTATE_BYTES);
}
