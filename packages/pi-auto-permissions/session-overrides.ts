import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoPermissionsConfig } from "./config.js";
import type { PromptChoiceClassification } from "./evaluation-log.js";
import type { PermissionOverride } from "./override-evidence.js";
import type { ReviewScope } from "./review-scope.js";
import type { DenialSummary } from "./settings-menu.js";
import {
  grantStandingApproval,
  readStandingApprovals,
  STANDING_APPROVAL_LIMIT,
  standingApprovalsToPermissionOverrides,
} from "./standing-overrides.js";

/**
 * Overrides persist as custom session entries the way the loop budget does,
 * so a resumed session keeps the user's prompt decisions instead of
 * forgetting every allow and standing block constraint.
 */
const OVERRIDES_ENTRY_TYPE = "auto-permissions-overrides";

export interface SessionOverrides {
  /** Commands a `request_override` grant cleared for the rest of this session. */
  readonly allowedConventionCommands: ReadonlySet<string>;
  /** The override records, live, for merging into reviewer evidence. */
  list(): readonly PermissionOverride[];
  allowConvention(command: string): void;
  activateOverrideTool(): void;
  reconcileOverrideTool(): void;
  persist(): void;
  restore(branch: readonly unknown[]): void;
  removeStanding(matches: (override: PermissionOverride) => boolean): void;
  loadStanding(config: AutoPermissionsConfig, ctx: ExtensionContext): void;
  recordPromptDecision(
    scope: ReviewScope,
    classification: PromptChoiceClassification,
    detail: string,
    anchorKey: string | undefined,
  ): void;
  allowRetry(denial: DenialSummary, anchorKey: string | undefined): void;
  resetForSession(): void;
}

/**
 * The user's own permission decisions for this session: the exception grants
 * that let a convention-blocked command run, and the override records the
 * guardian is shown as user-source evidence.
 *
 * One owner, because the pieces are one fact seen three ways — the in-memory
 * record, the session entry that survives a resume, and (for standing
 * approvals) the cross-project ledger.
 */
export function createSessionOverrides(pi: ExtensionAPI): SessionOverrides {
  const allowedConventionCommands = new Set<string>();
  const permissionOverrides: PermissionOverride[] = [];
  let overrideSeq = 0;
  let standingApprovalCapNotified = false;
  let overrideToolActivated = false;

  function reconcileOverrideTool(): void {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
    const active = pi.getActiveTools();
    const present = active.includes("request_override");
    if (overrideToolActivated === present) return;
    pi.setActiveTools(
      overrideToolActivated
        ? [...active, "request_override"]
        : active.filter((name) => name !== "request_override"),
    );
  }

  function persist(): void {
    try {
      pi.appendEntry(OVERRIDES_ENTRY_TYPE, {
        seq: overrideSeq,
        overrides: permissionOverrides
          .filter((override) => !override.standing)
          .map((override) => ({ ...override })),
      });
    } catch {
      // Persistence is best-effort; the in-memory records still apply now.
    }
  }

  /** Fail-open like the loop budget: unreadable state means no overrides. */
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
            || !["allow", "allow_unnecessary", "allow_appropriate", "block"].includes(candidate.choice)
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

  /** Drop matching ledger-backed evidence in place; the array is shared by reference. */
  function removeStanding(matches: (override: PermissionOverride) => boolean): void {
    const kept = permissionOverrides.filter((override) => !override.standing || !matches(override));
    permissionOverrides.splice(0, permissionOverrides.length, ...kept);
  }

  return {
    allowedConventionCommands,
    list: () => permissionOverrides,
    allowConvention(command: string): void {
      allowedConventionCommands.add(command);
    },
    reconcileOverrideTool,
    activateOverrideTool(): void {
      overrideToolActivated = true;
      reconcileOverrideTool();
    },
    persist,
    removeStanding,

    restore(branch: readonly unknown[]): void {
      // Restore prompt decisions from the branch: a resumed session keeps its
      // allows and standing block constraints (parity with the loop budget).
      restoreOverrides(branch);
      for (const entry of branch as Array<{
        type?: string;
        message?: { role?: string; toolName?: string; details?: unknown };
      }>) {
        if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
        if (entry.message.toolName !== "request_override") continue;
        const details = entry.message.details as { success?: boolean; command?: string } | undefined;
        if (details?.success && details.command) allowedConventionCommands.add(details.command);
      }
    },

    /** Replace only ledger-backed evidence; session prompt decisions stay put. */
    loadStanding(config: AutoPermissionsConfig, ctx: ExtensionContext): void {
      removeStanding(() => true);
      if (!config.standingApprovals.enabled) return;
      try {
        const records = readStandingApprovals(config.standingApprovals.path);
        permissionOverrides.push(...standingApprovalsToPermissionOverrides(records));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not load standing Auto Permissions approvals: ${message}`, "warning");
      }
    },

    /**
     * Feed the user's decision back to the guardian as session-scoped
     * user-source evidence. Only the caller knows whether the prompt came from
     * a guardian judgment, which is the one case this may be called for.
     */
    recordPromptDecision(
      scope: ReviewScope,
      classification: PromptChoiceClassification,
      detail: string,
      anchorKey: string | undefined,
    ): void {
      const { ctx, config, gate, command } = scope;
      const overrideChoice = classification.userChoice ?? (classification.allowsExecution ? "allow" as const : undefined);
      if (!overrideChoice) return;
      let recordedStanding = false;
      if (classification.standingApproval && config.standingApprovals.enabled) {
        try {
          const { evicted, override } = grantStandingApproval(
            config.standingApprovals.path,
            {
              gate: { label: gate.label, group: gate.group },
              command,
              project: ctx.cwd,
              reason: detail,
            },
            overrideSeq++,
            anchorKey,
          );
          removeStanding(
            (existing) => existing.standing?.gateGroup === gate.group && existing.command === command,
          );
          permissionOverrides.push(override);
          recordedStanding = true;
          if (evicted > 0 && !standingApprovalCapNotified) {
            standingApprovalCapNotified = true;
            ctx.ui.notify(
              `Standing approvals reached ${STANDING_APPROVAL_LIMIT} entries; the oldest approval was removed.`,
              "warning",
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Could not save standing approval: ${message}`, "warning");
        }
      }
      if (!recordedStanding) {
        permissionOverrides.push({
          seq: overrideSeq++,
          anchorKey,
          gateLabel: gate.label,
          command,
          reviewerReason: detail,
          choice: overrideChoice,
        });
      }
      persist();
    },

    /**
     * "Allow on retry": the existing override machinery, driven from the
     * denial ledger. An exact-command allow override (which already
     * generalizes correctly and survives via evidence re-injection and the
     * session entry), plus a visible injected message telling the agent it
     * may retry. No new authorization pathway.
     */
    allowRetry(denial: DenialSummary, anchorKey: string | undefined): void {
      permissionOverrides.push({
        seq: overrideSeq++,
        anchorKey,
        gateLabel: denial.gateLabel,
        command: denial.command,
        reviewerReason: denial.reason,
        choice: "allow",
      });
      persist();
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

    resetForSession(): void {
      overrideToolActivated = false;
      reconcileOverrideTool();
      standingApprovalCapNotified = false;
      allowedConventionCommands.clear();
    },
  };
}
