import type { ReviewEvidenceRecord } from "./review.js";

/**
 * A decision the user made on an earlier permission prompt in this session.
 * Overrides are session-scoped, in-memory, and injected into the reviewer
 * evidence stream as user-source records so the guardian can treat them as
 * authorization (allows) or standing constraints (blocks).
 */
export interface PermissionOverride {
  seq: number;
  /**
   * Key of the evidence record this override chronologically follows. Locked
   * on first merge when initially undefined so the record keeps a stable
   * position across re-collections (required by reviewer lineage prefix
   * matching).
   */
  anchorKey?: string;
  gateLabel: string;
  command: string;
  reviewerReason: string;
  choice: "allow" | "allow_unnecessary" | "allow_appropriate" | "block";
  /** Present only for a user-scoped ledger approval loaded at session start. */
  standing?: {
    grantedAt: string;
    project: string;
    gateGroup: string;
  };
}

/** Anchor value meaning "before every collected record". */
export const OVERRIDE_ANCHOR_START = "";

const COMMAND_PREVIEW_MAX_CHARS = 300;

function commandPreview(command: string): string {
  if (command.length <= COMMAND_PREVIEW_MAX_CHARS) return command;
  const head = Math.ceil(COMMAND_PREVIEW_MAX_CHARS * 0.7);
  const tail = COMMAND_PREVIEW_MAX_CHARS - head;
  return `${command.slice(0, head)}…[truncated ${command.length - COMMAND_PREVIEW_MAX_CHARS} chars]…${command.slice(-tail)}`;
}

export function overrideEvidenceRecord(override: PermissionOverride): ReviewEvidenceRecord {
  const command = JSON.stringify(commandPreview(override.command));
  const gate = JSON.stringify(override.gateLabel);
  const concern = JSON.stringify(commandPreview(override.reviewerReason));
  if (override.standing) {
    const granted = override.standing.grantedAt.slice(0, 10);
    const project = JSON.stringify(commandPreview(override.standing.project));
    const group = JSON.stringify(override.standing.gateGroup);
    return {
      key: `override:${override.seq}`,
      source: "user",
      text: `USER (standing permission override, granted ${granted} in ${project}): allowed gated command ${command} (gate ${gate}, group ${group}) despite reviewer concern ${concern}. Treat comparable actions in any project as authorized unless a later user statement or block contradicts this. This never authorizes an action of a materially higher risk class.`,
    };
  }
  let text: string;
  switch (override.choice) {
    case "allow_unnecessary":
      text = `USER (permission override): allowed gated command ${command} (gate ${gate}) and marked the review prompt unnecessary, despite reviewer concern ${concern}. Treat comparable actions in this session as authorized unless a later user statement contradicts this.`;
      break;
    case "allow_appropriate":
      text = `USER (permission override): allowed gated command ${command} (gate ${gate}) after reviewer concern ${concern}, agreeing the review prompt was appropriate. This authorizes exactly that action, not comparable ones.`;
      break;
    case "allow":
      text = `USER (permission override): allowed gated command ${command} (gate ${gate}) despite reviewer concern ${concern}. This authorizes that exact action and closely similar retries in this session.`;
      break;
    case "block":
      text = `USER (permission override): blocked gated command ${command} (gate ${gate}) after reviewer concern ${concern}. Treat this as a standing user constraint against comparable actions in this session unless a later user statement contradicts it.`;
      break;
  }
  return { key: `override:${override.seq}`, source: "user", text };
}

/**
 * Deterministically interleave override records into collected evidence.
 *
 * Each override is inserted immediately after the record matching its
 * anchorKey (multiple overrides on one anchor keep seq order). An override
 * with no anchor, or whose anchor is no longer present, is appended at the
 * end and its anchorKey is locked to the preceding record's key so every
 * future merge reproduces the same position; this keeps the merged list an
 * append-only extension of previously merged lists, which reviewer lineage
 * prefix matching depends on.
 */
export function mergeOverrideEvidence(
  records: readonly ReviewEvidenceRecord[],
  overrides: readonly PermissionOverride[],
): ReviewEvidenceRecord[] {
  if (overrides.length === 0) return [...records];
  // Anchors may reference collected record keys or earlier overrides' own
  // record keys (override:<seq>), because an unanchored override locks to
  // whatever record precedes it — which can itself be an override.
  const validAnchors = new Set(records.map((record) => record.key));
  for (const override of overrides) validAnchors.add(`override:${override.seq}`);
  const anchored = new Map<string, PermissionOverride[]>();
  const unanchored: PermissionOverride[] = [];
  for (const override of overrides) {
    if (override.anchorKey !== undefined && (override.anchorKey === OVERRIDE_ANCHOR_START || validAnchors.has(override.anchorKey))) {
      const list = anchored.get(override.anchorKey) ?? [];
      list.push(override);
      anchored.set(override.anchorKey, list);
    } else {
      unanchored.push(override);
    }
  }
  for (const list of anchored.values()) list.sort((a, b) => a.seq - b.seq);
  unanchored.sort((a, b) => a.seq - b.seq);

  const merged: ReviewEvidenceRecord[] = [];
  const pushWithFollowers = (record: ReviewEvidenceRecord): void => {
    merged.push(record);
    for (const follower of anchored.get(record.key) ?? []) {
      pushWithFollowers(overrideEvidenceRecord(follower));
    }
  };
  for (const override of anchored.get(OVERRIDE_ANCHOR_START) ?? []) {
    pushWithFollowers(overrideEvidenceRecord(override));
  }
  for (const record of records) {
    pushWithFollowers(record);
  }
  for (const override of unanchored) {
    override.anchorKey = merged.length > 0 ? merged[merged.length - 1].key : OVERRIDE_ANCHOR_START;
    pushWithFollowers(overrideEvidenceRecord(override));
  }
  return merged;
}
