import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/** Rotate once the sidecar grows past this size; one previous generation is kept. */
const DENIAL_LOG_ROTATE_BYTES = 16 * 1024 * 1024;

/** The two ways a review can end without the command running. */
export type DenialVerdict = "revise" | "block";

/**
 * What produced the denial:
 * - `deny` / `convention` — a rule blocked mechanically, no reviewer involved
 * - `guardian` — the reviewer's own verdict (a revise, or an ask_user with no
 *   interactive user to ask)
 * - `user` — the user chose Block at the approval prompt
 * - `loop` — a guardian verdict delivered as a bounded block because an
 *   unattended loop cannot answer a prompt
 * - `review_failure` — review infrastructure failed and the command was
 *   blocked rather than waved through
 */
export type DenialSource = "deny" | "convention" | "guardian" | "user" | "loop" | "review_failure";

export interface DenialRecord {
  v: 1;
  id: string;
  ts: string;
  sessionId: string;
  cwd: string;
  tool: string;
  gate: { label: string; group: string };
  command: string;
  verdict: DenialVerdict;
  reason: string;
  decisionSource: DenialSource;
}

export function buildDenialRecord(input: {
  sessionId: string;
  cwd: string;
  tool: string;
  gate: { label: string; group: string };
  command: string;
  verdict: DenialVerdict;
  reason: string;
  decisionSource: DenialSource;
}): DenialRecord {
  return {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    sessionId: input.sessionId,
    cwd: input.cwd,
    tool: input.tool,
    gate: { label: input.gate.label, group: input.gate.group },
    command: input.command,
    verdict: input.verdict,
    reason: input.reason,
    decisionSource: input.decisionSource,
  };
}

function rotateIfLarge(path: string): void {
  try {
    if (statSync(path).size < DENIAL_LOG_ROTATE_BYTES) return;
    renameSync(path, `${path}.1`);
  } catch {
    // A missing or unrotatable sidecar simply keeps appending.
  }
}

export function appendDenialRecord(path: string, record: DenialRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rotateIfLarge(path);
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * The newest `limit` denials, newest first, for the `/auto-permissions`
 * Recent denials view. Malformed lines are skipped, a missing file is an
 * empty history, and only the live generation is read — the rotated `.1`
 * file is archival.
 */
export function readRecentDenials(path: string, limit: number): DenialRecord[] {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records: DenialRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as DenialRecord;
      if (
        value && typeof value === "object" && value.v === 1
        && typeof value.command === "string"
        && typeof value.reason === "string"
        && (value.verdict === "revise" || value.verdict === "block")
        && value.gate && typeof value.gate.label === "string" && typeof value.gate.group === "string"
      ) {
        records.push(value);
      }
    } catch {
      // Skip unparsable lines; the log is append-only best effort.
    }
  }
  return records.slice(-limit).reverse();
}
