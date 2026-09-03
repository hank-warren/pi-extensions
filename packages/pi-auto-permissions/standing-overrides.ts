import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { pid } from "node:process";
import { OVERRIDE_ANCHOR_START, type PermissionOverride } from "./override-evidence.js";

const STANDING_APPROVAL_SCOPE = "comparable" as const;
export const STANDING_APPROVAL_LIMIT = 200;
const STALE_LEDGER_LOCK_MS = 60_000;

export interface StandingApprovalRecord {
  v: 1;
  ts: string;
  gate: {
    label: string;
    group: string;
  };
  command: string;
  scope: typeof STANDING_APPROVAL_SCOPE;
  project: string;
  reason: string;
}

interface StandingApprovalInput {
  gate: StandingApprovalRecord["gate"];
  command: string;
  project: string;
  reason: string;
  timestamp?: Date;
}

export function buildStandingApprovalRecord(input: StandingApprovalInput): StandingApprovalRecord {
  return {
    v: 1,
    ts: (input.timestamp ?? new Date()).toISOString(),
    gate: { label: input.gate.label, group: input.gate.group },
    command: input.command,
    scope: STANDING_APPROVAL_SCOPE,
    project: input.project,
    reason: input.reason,
  };
}

function parseRecord(value: unknown): StandingApprovalRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<StandingApprovalRecord>;
  const gate = record.gate as Partial<StandingApprovalRecord["gate"]> | undefined;
  if (
    record.v !== 1
    || typeof record.ts !== "string"
    || !Number.isFinite(Date.parse(record.ts))
    || !gate
    || typeof gate.label !== "string"
    || !gate.label.trim()
    || typeof gate.group !== "string"
    || !gate.group.trim()
    || typeof record.command !== "string"
    || !record.command.trim()
    || record.scope !== STANDING_APPROVAL_SCOPE
    || typeof record.project !== "string"
    || !record.project.trim()
    || typeof record.reason !== "string"
    || !record.reason.trim()
  ) {
    return undefined;
  }
  return {
    v: 1,
    ts: record.ts,
    gate: { label: gate.label.trim(), group: gate.group.trim() },
    command: record.command,
    scope: STANDING_APPROVAL_SCOPE,
    project: record.project.trim(),
    reason: record.reason.trim(),
  };
}

/** Read valid records in file order. Malformed and future-version lines are ignored. */
export function readStandingApprovals(path: string): StandingApprovalRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: StandingApprovalRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = parseRecord(JSON.parse(line));
      if (record) records.push(record);
    } catch {
      // One corrupt line must not discard later user approvals.
    }
  }
  return records;
}

function openLedgerLock(lockPath: string): number {
  try {
    return openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

    let modifiedAt: number;
    try {
      modifiedAt = statSync(lockPath).mtimeMs;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
        return openSync(lockPath, "wx", 0o600);
      }
      throw statError;
    }
    if (Date.now() - modifiedAt <= STALE_LEDGER_LOCK_MS) throw error;

    // Rename, rather than unlink, so two processes cannot both decide that the
    // same stale lock is theirs to remove. Only one rename can win.
    const stalePath = `${lockPath}.stale.${pid}.${Date.now()}`;
    try {
      renameSync(lockPath, stalePath);
    } catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code === "ENOENT") {
        return openSync(lockPath, "wx", 0o600);
      }
      throw renameError;
    }
    try {
      return openSync(lockPath, "wx", 0o600);
    } finally {
      try {
        unlinkSync(stalePath);
      } catch {
        // The stale lock has already been displaced; cleanup is best effort.
      }
    }
  }
}

function withLedgerLock<T>(path: string, operation: () => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const descriptor = openLedgerLock(lockPath);
  try {
    return operation();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch {
      // The operation's result is authoritative; lock cleanup is best effort.
    }
  }
}

/** Callers hold the ledger lock, whose acquisition already created the directory. */
function writeStandingApprovals(path: string, records: readonly StandingApprovalRecord[]): void {
  const temporary = `${path}.${pid}.tmp`;
  try {
    writeFileSync(
      temporary,
      records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "",
      { encoding: "utf8", mode: 0o600 },
    );
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

export function appendStandingApproval(
  path: string,
  record: StandingApprovalRecord,
): { evicted: number } {
  return withLedgerLock(path, () => {
    // Re-granting the same command refreshes one approval instead of inflating
    // the ledger and every review envelope that consumes it.
    const records = readStandingApprovals(path)
      .filter((existing) => existing.gate.group !== record.gate.group || existing.command !== record.command);
    records.push(record);
    const evicted = Math.max(0, records.length - STANDING_APPROVAL_LIMIT);
    writeStandingApprovals(path, records.slice(evicted));
    return { evicted };
  });
}

function standingApprovalToPermissionOverride(
  record: StandingApprovalRecord,
  seq: number,
  anchorKey: string = OVERRIDE_ANCHOR_START,
): PermissionOverride {
  return {
    seq,
    anchorKey,
    gateLabel: record.gate.label,
    command: record.command,
    reviewerReason: record.reason,
    choice: "allow_unnecessary",
    standing: {
      grantedAt: record.ts,
      project: record.project,
      gateGroup: record.gate.group,
    },
  };
}

/** Session-start projection: ledger records precede this session's evidence. */
export function standingApprovalsToPermissionOverrides(
  records: readonly StandingApprovalRecord[],
): PermissionOverride[] {
  return records.map((record, index) => standingApprovalToPermissionOverride(record, index - records.length));
}

/** One prompt selection atomically writes the ledger and yields live evidence. */
export function grantStandingApproval(
  path: string,
  input: StandingApprovalInput,
  seq: number,
  anchorKey?: string,
): { record: StandingApprovalRecord; override: PermissionOverride; evicted: number } {
  const record = buildStandingApprovalRecord(input);
  const { evicted } = appendStandingApproval(path, record);
  return {
    record,
    override: standingApprovalToPermissionOverride(record, seq, anchorKey),
    evicted,
  };
}

function sameRecord(left: StandingApprovalRecord, right: StandingApprovalRecord): boolean {
  return left.ts === right.ts
    && left.gate.label === right.gate.label
    && left.gate.group === right.gate.group
    && left.command === right.command
    && left.scope === right.scope
    && left.project === right.project
    && left.reason === right.reason;
}

/** Remove one selected record and preserve 0600 on the rewritten ledger. */
export function revokeStandingApproval(path: string, selected: StandingApprovalRecord): boolean {
  return withLedgerLock(path, () => {
    const records = readStandingApprovals(path);
    const index = records.findIndex((record) => sameRecord(record, selected));
    if (index < 0) return false;
    records.splice(index, 1);
    writeStandingApprovals(path, records);
    return true;
  });
}
