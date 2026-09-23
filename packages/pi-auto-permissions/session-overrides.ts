import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PromptChoiceClassification } from "./evaluation-log.js";
import type { Gate } from "./gates.js";
import { PERMISSION_OVERRIDE_CHOICES, type PermissionOverride } from "./override-evidence.js";
import type { DenialSummary } from "./settings-menu.js";

/**
 * Overrides persist as custom session entries,
 * so a resumed session keeps the user's prompt decisions instead of
 * forgetting every allow and standing block constraint.
 */
const OVERRIDES_ENTRY_TYPE = "auto-permissions-overrides";

export interface SessionOverrides {
  /** The override records, live, for merging into reviewer evidence. */
  list(): readonly PermissionOverride[];
  restore(branch: readonly unknown[]): void;
  recordPromptDecision(
    gate: Pick<Gate, "label">,
    command: string,
    classification: PromptChoiceClassification,
    detail: string,
    anchorKey: string | undefined,
  ): void;
  allowRetry(denial: DenialSummary, anchorKey: string | undefined): void;
}

/**
 * The user's own permission decisions for this session: the override records
 * the guardian is shown as user-source evidence.
 *
 * One owner, because the pieces are one fact seen two ways — the in-memory
 * record and the session entry that survives a resume.
 */
export function createSessionOverrides(pi: ExtensionAPI): SessionOverrides {
  const permissionOverrides: PermissionOverride[] = [];
  let overrideSeq = 0;

  function persist(): void {
    try {
      pi.appendEntry(OVERRIDES_ENTRY_TYPE, {
        seq: overrideSeq,
        overrides: permissionOverrides.map((override) => ({ ...override })),
      });
    } catch {
      // Persistence is best-effort; the in-memory records still apply now.
    }
  }

  /** Fail-open: unreadable state means no overrides. */
  function restoreOverrides(entries: readonly unknown[]): void {
    permissionOverrides.length = 0;
    overrideSeq = 0;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index] as { type?: string; customType?: string; data?: unknown } | undefined;
      if (entry?.type !== "custom" || entry.customType !== OVERRIDES_ENTRY_TYPE) continue;
      const data = entry.data as { seq?: unknown; overrides?: unknown } | undefined;
      if (Array.isArray(data?.overrides)) {
        for (const raw of data.overrides) {
          if (!raw || typeof raw !== "object") continue;
          const candidate = raw as PermissionOverride;
          if (
            typeof candidate.seq !== "number"
            || typeof candidate.gateLabel !== "string"
            || typeof candidate.command !== "string"
            || typeof candidate.reviewerReason !== "string"
            || !PERMISSION_OVERRIDE_CHOICES.includes(candidate.choice)
          ) {
            continue;
          }
          permissionOverrides.push({
            seq: candidate.seq,
            ...(typeof candidate.anchorKey === "string" ? { anchorKey: candidate.anchorKey } : {}),
            gateLabel: candidate.gateLabel,
            command: candidate.command,
            reviewerReason: candidate.reviewerReason,
            choice: candidate.choice,
          });
        }
      }
      if (typeof data?.seq === "number" && Number.isSafeInteger(data.seq) && data.seq >= 0) {
        overrideSeq = data.seq;
      }
      return;
    }
  }

  function addOverride(
    gateLabel: string,
    command: string,
    reviewerReason: string,
    choice: PermissionOverride["choice"],
    anchorKey: string | undefined,
  ): void {
    permissionOverrides.push({ seq: overrideSeq++, anchorKey, gateLabel, command, reviewerReason, choice });
    persist();
  }

  return {
    list: () => permissionOverrides,

    restore(branch: readonly unknown[]): void {
      // Restore prompt decisions from the branch: a resumed session keeps its
      // allows and standing block constraints.
      restoreOverrides(branch);
    },

    /**
     * Feed the user's decision back to the guardian as session-scoped
     * user-source evidence. Only the caller knows whether the prompt came from
     * a guardian judgment, which is the one case this may be called for.
     */
    recordPromptDecision(
      gate: Pick<Gate, "label">,
      command: string,
      classification: PromptChoiceClassification,
      detail: string,
      anchorKey: string | undefined,
    ): void {
      const overrideChoice = classification.userChoice ?? (classification.allowsExecution ? "allow" as const : undefined);
      if (!overrideChoice) return;
      addOverride(gate.label, command, detail, overrideChoice, anchorKey);
    },

    /**
     * "Allow on retry": the existing override machinery, driven from the
     * denial ledger. An exact-command allow override (which already
     * generalizes correctly and survives via evidence re-injection and the
     * session entry), plus a visible injected message telling the agent it
     * may retry. No new authorization pathway.
     */
    allowRetry(denial: DenialSummary, anchorKey: string | undefined): void {
      addOverride(denial.gateLabel, denial.command, denial.reason, "allow", anchorKey);
      try {
        // The same channel a prompt note uses. This is a real user decision
        // made in the menu, so a user message is honest provenance — and it
        // gives the agent a turn to actually retry.
        pi.sendUserMessage(
          `Auto Permissions: I reviewed the denied command in /auto-permissions and allowed it on retry:\n\n  ${denial.command}\n\nYou may run this exact command again; a session override now authorizes it.`,
        );
      } catch {
        // The override itself is already in force; the nudge is best-effort.
      }
    },
  };
}
