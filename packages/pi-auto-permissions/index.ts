import { detectLoopContext } from "./loop-context.js";
import { createReviewQueue } from "./review-queue.js";
import {
  LoopReviseBudget,
  loopBlockReason,
  type LoopReviseCharge,
} from "./loop-revise-budget.js";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAutoPermissionsConfig, type AutoPermissionsConfig } from "./config.js";
import {
  appendDenialRecord,
  buildDenialRecord,
  type DenialSource,
  type DenialVerdict,
} from "./denial-log.js";
import {
  appendPromptEvaluation,
  classifyPromptChoice,
  expectedDecisionForChoice,
  permissionPromptOptions,
  shouldOfferStandingApproval,
  type PromptEvaluationUserChoice,
} from "./evaluation-log.js";
import type { Gate } from "./gates.js";
import { classifyCommand, untrustedMatches } from "./classify.js";
import type { ReviewEvidenceRecord } from "./review.js";
import { promptSelect, setHerdrBlocked } from "./prompt-select.js";
import { createReviewDisplay } from "./review-display.js";
import { createSessionOverrides } from "./session-overrides.js";
import { createGuardianReviewer } from "./guardian-reviewer.js";
import { registerSettingsCommand } from "./settings-command.js";
import type { BlockResult, ReviewScope, ReviewTarget } from "./review-scope.js";
import type { ReviewDisplayState } from "./widget-status.js";

/**
 * How one gated command ends: what the user is shown, what the denial log and
 * the `auto-permissions:denied` event record, and what the agent is told.
 *
 * Every ending goes through `settle`, so the three can never disagree — the
 * bug that shape exists to prevent is a denial recorded with one reason and
 * displayed with another.
 */
interface ReviewOutcome {
  /** Absent for the mechanical rules, which decide without ever rendering. */
  display?: ReviewDisplayState;
  /** Shown under the status line; defaults to `reason`. */
  detail?: string;
  /** Present together with `source` when this ending is a recorded denial. */
  verdict?: DenialVerdict;
  source?: DenialSource;
  /** The reason recorded, and by default the one displayed. */
  reason: string;
  /** What the agent is told; absent means the command runs. */
  block?: string;
}

const PROJECT_CONFIG_DIR_NAME = (PiCodingAgent as { CONFIG_DIR_NAME?: string }).CONFIG_DIR_NAME ?? ".pi";

function loadTrustedGroups(cwd: string): Set<string> {
  const groups = new Set<string>();
  try {
    const content = readFileSync(join(cwd, PROJECT_CONFIG_DIR_NAME, "trusted-ops"), "utf8");
    for (const line of content.split("\n")) {
      const value = line.trim();
      if (value && !value.startsWith("#")) groups.add(value);
    }
  } catch {
    // Missing or unreadable means no trusted groups.
  }
  return groups;
}

function denyReason(gate: Gate): string {
  return `Blocked by policy: ${gate.label}\n\n${gate.message ?? "This operation is denied by rule."}\n\nThis is a deny rule: it cannot be overridden with request_override, trusted groups, or user approval. Choose a different approach.`;
}

function conventionReason(gate: Gate, command: string): string {
  let reason = `Convention violation: ${gate.label}\n\n${gate.message ?? "Use the configured project tooling."}`;
  const suggestion = gate.suggest?.(command);
  if (suggestion && suggestion !== command) reason += `\n\nSuggested command:\n  ${suggestion}`;
  return `${reason}\n\nIf this is a legitimate edge case, explain why and call \`request_override\` with the exact command.`;
}

export default function autoPermissionsExtension(pi: ExtensionAPI) {
  const overrides = createSessionOverrides(pi);
  let trustedGroups = new Set<string>();
  let lastConfigError: string | undefined;
  let lastEvaluationLogError: string | undefined;
  let sessionActive = true;
  /**
   * Revision rounds spent per guardian concern while a loop is active.
   *
   * Session-scoped and held here rather than in the review closure, so a
   * context compaction (which rewrites the conversation, not this process)
   * cannot reset it. Restored from the session branch at session_start so a
   * resume cannot reset it either.
   */
  const loopReviseBudget = new LoopReviseBudget();
  /** The loop these counts belong to, so a new loop starts with a clean budget. */
  let loopReviseBudgetLoopId: string | undefined;
  const guardianReviewQueue = createReviewQueue();
  const display = createReviewDisplay(pi, { isSessionActive: () => sessionActive });
  const reviewer = createGuardianReviewer({ isSessionActive: () => sessionActive, overrides });

  /**
   * Record a non-approved outcome: a `pi.events` emit (the PermissionDenied
   * hook equivalent) always, plus a denial-log line when enabled. Never blocks
   * the decision itself.
   */
  function recordDenial(
    scope: ReviewScope,
    verdict: DenialVerdict,
    reason: string,
    decisionSource: DenialSource,
  ): void {
    const { ctx, config, gate, command, target } = scope;
    try {
      pi.events.emit("auto-permissions:denied", {
        tool: target.toolName,
        command,
        gate: gate.label,
        group: gate.group,
        verdict,
        reason,
        decisionSource,
      });
    } catch {
      // Event fan-out is observability, never part of the decision.
    }
    if (!config.denialLog.enabled) return;
    try {
      appendDenialRecord(config.denialLog.path, buildDenialRecord({
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        tool: target.toolName,
        gate: { label: gate.label, group: gate.group },
        command,
        verdict,
        reason,
        decisionSource,
      }));
    } catch {
      // The denial log is best-effort observability.
    }
  }

  /** The one place a decision is recorded, rendered and returned. */
  function settle(scope: ReviewScope, outcome: ReviewOutcome): BlockResult | undefined {
    if (outcome.verdict && outcome.source) {
      recordDenial(scope, outcome.verdict, outcome.reason, outcome.source);
    }
    if (outcome.display) {
      display.show(scope, outcome.display, outcome.detail ?? outcome.reason, true);
    }
    return outcome.block === undefined ? undefined : { block: true, reason: outcome.block };
  }

  function currentConfig(ctx?: ExtensionContext): AutoPermissionsConfig {
    try {
      const config = loadAutoPermissionsConfig();
      lastConfigError = undefined;
      return config;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastConfigError) {
        lastConfigError = message;
        console.error(`[pi-auto-permissions] invalid config: ${message}`);
        ctx?.ui.notify(`Auto Permissions config error: ${message}`, "warning");
      }
      throw new Error(`Auto Permissions configuration is invalid: ${message}`);
    }
  }

  /**
   * The dedicated `openai-codex-auto-permissions` login used to be registered
   * here. It now belongs to @hank-warren/pi-multi-login, which adopts the
   * existing credential, so an existing reviewer config keeps working — but only
   * if that package is installed. Say so once per session instead of letting the
   * first guarded command fail with a bare "review model not found".
   */
  function warnAboutMissingReviewerProvider(ctx: ExtensionContext): void {
    let provider: string | undefined;
    try {
      provider = currentConfig(ctx).reviewer?.provider;
    } catch {
      return; // The config error was already reported by currentConfig().
    }
    if (!provider || ctx.modelRegistry.getProvider(provider)) return;

    const message =
      `reviewer provider "${provider}" is not registered. Install @hank-warren/pi-multi-login to` +
      ` provide additional logins such as this one, or point reviewer.provider at a signed-in provider.`;
    console.warn(`[pi-auto-permissions] ${message}`);
    ctx.ui.notify(`Auto Permissions: ${message}`, "warning");
  }

  function reviewCancelled(signal: AbortSignal | undefined): boolean {
    return !sessionActive || signal?.aborted === true;
  }

  function logPromptEvaluation(
    scope: ReviewScope,
    detail: string,
    relevantContext: ReviewEvidenceRecord[],
    decisionSource: "guardian" | "review_failure",
    userChoice: PromptEvaluationUserChoice,
  ): void {
    const { ctx, config, gate, command, target } = scope;
    if (!config.evaluationLog.enabled) return;
    try {
      const userRequest = relevantContext
        .filter((record) => record.source === "user")
        .map((record) => record.text)
        .join("\n");
      appendPromptEvaluation(config.evaluationLog.path, {
        version: 2,
        timestamp: new Date().toISOString(),
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        tool: target.toolName,
        gate: { label: gate.label, group: gate.group },
        userRequest,
        command,
        relevantContext,
        actualDecision: "ask_user",
        actualReason: detail,
        decisionSource,
        userChoice,
        expectedDecision: expectedDecisionForChoice(userChoice),
      });
      lastEvaluationLogError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastEvaluationLogError) {
        lastEvaluationLogError = message;
        console.error(`[pi-auto-permissions] could not append evaluation log: ${message}`);
        ctx.ui.notify("Auto Permissions could not append its evaluation log.", "warning");
      }
    }
  }

  /**
   * Charge one revision round against a guardian concern and persist the
   * budget. A loop id different from the one the counts belong to means a new
   * loop: it inherits nothing from the last one's arguments with the guardian.
   */
  function chargeLoopRevision(
    loopId: string | undefined,
    gateLabel: string,
    reason: string,
  ): LoopReviseCharge {
    if (loopReviseBudgetLoopId !== loopId) {
      loopReviseBudget.clear();
      loopReviseBudgetLoopId = loopId;
    }
    const charge = loopReviseBudget.charge(gateLabel, reason);
    try {
      pi.appendEntry(LoopReviseBudget.entryType, {
        ...loopReviseBudget.snapshot(),
        ...(loopId ? { loopId } : {}),
      });
    } catch {
      // Persistence is what survives a restore; the in-memory count is what
      // survives a compaction. Losing the former never widens the bound now.
    }
    return charge;
  }

  async function askUser(
    scope: ReviewScope,
    detail: string,
    lifecycleSignal: AbortSignal,
    decisionSource: "guardian" | "review_failure",
  ): Promise<BlockResult | undefined> {
    const { ctx, config, gate, command } = scope;
    const signal = ctx.signal;
    const lifecycleStale = () => reviewer.isStale(lifecycleSignal);
    const promptSignal = signal ? AbortSignal.any([signal, lifecycleSignal]) : lifecycleSignal;
    const cancelled = (): BlockResult => ({ block: true, reason: "Auto Permissions review cancelled" });
    if (lifecycleStale() || reviewCancelled(signal)) {
      if (!lifecycleStale()) reviewer.discardLineage();
      return cancelled();
    }
    display.show(scope, "ask_user", detail);
    if (!ctx.hasUI) {
      return settle(scope, {
        display: "blocked",
        verdict: "block",
        source: decisionSource === "guardian" ? "guardian" : "review_failure",
        reason: detail,
        block: `${gate.label} requires user approval: ${detail}\nThis session has no interactive user to ask. Prefer an approach that avoids the gated operation, or report this blocker in your final output instead of retrying the same command.`,
      });
    }

    const evaluationContext = config.evaluationLog.enabled ? reviewer.collectEvidence(scope) : [];
    setHerdrBlocked(pi, true, gate.label);
    try {
      let choice: string | undefined;
      try {
        choice = await promptSelect(
          pi,
          ctx,
          `${gate.label} — Auto Permissions needs approval\n\n${detail}\n\n${command}`,
          permissionPromptOptions(
            config.evaluationLog.enabled,
            shouldOfferStandingApproval(decisionSource, config.standingApprovals.enabled),
          ),
          promptSignal,
          { allowComment: true },
        );
      } catch (error) {
        if (!lifecycleStale() && !reviewCancelled(signal)) throw error;
        if (!lifecycleStale()) reviewer.discardLineage();
        return cancelled();
      }
      if (lifecycleStale()) return cancelled();
      if (reviewCancelled(signal)) {
        reviewer.discardLineage();
        if (sessionActive) display.clear(scope);
        return cancelled();
      }
      const classification = classifyPromptChoice(choice);
      // Feed the user's decision back to the guardian as session-scoped
      // user-source evidence. review_failure prompts are excluded: their
      // "concern" is an infrastructure error, not a guardian judgment.
      if (decisionSource === "guardian" && classification) {
        overrides.recordPromptDecision(scope, classification, detail, reviewer.lastEvidenceKey);
      }
      if (config.evaluationLog.enabled && classification?.userChoice) {
        logPromptEvaluation(scope, detail, evaluationContext, decisionSource, classification.userChoice);
      }
      if (classification?.allowsExecution) {
        return settle(scope, { display: "approved", reason: "approved by user" });
      }
      return settle(scope, {
        display: "blocked",
        detail: "blocked by user",
        verdict: "block",
        source: decisionSource === "guardian" ? "user" : "review_failure",
        reason: detail,
        block: "Blocked by user",
      });
    } finally {
      if (!lifecycleStale()) setHerdrBlocked(pi, false);
    }
  }

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" && !event.toolName.endsWith(".bash")) return;
    const command = (event.input as { command: string }).command;
    const lifecycleSignal = reviewer.lifecycleSignal;
    const lifecycleStale = () => reviewer.isStale(lifecycleSignal);

    let config: AutoPermissionsConfig;
    try {
      config = currentConfig(ctx);
    } catch (error) {
      reviewer.discardLineage();
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
    if (!config.enabled) return;
    const target: ReviewTarget = { toolName: event.toolName, toolCallId: event.toolCallId };
    const classified = classifyCommand(command, config, trustedGroups, overrides.allowedConventionCommands);
    if (classified.kind === "pass") return;
    const gate = classified.gate;
    const scope: ReviewScope = { ctx, config, gate, command, target };
    if (classified.kind === "deny") {
      return settle(scope, {
        verdict: "block",
        source: "deny",
        reason: gate.message ?? gate.label,
        block: denyReason(gate),
      });
    }
    if (classified.kind === "convention") {
      if (ctx.hasUI) overrides.activateOverrideTool();
      return settle(scope, {
        verdict: "block",
        source: "convention",
        reason: gate.message ?? gate.label,
        block: conventionReason(gate, command),
      });
    }

    // Show the queued row *before* waiting, and only when there is actually
    // something to wait for: the critical section spans the human prompt, so a
    // second guarded command in the same turn can sit here for as long as it
    // takes someone to answer. Rendering nothing for that whole time reads as a
    // hang. A lone review never flashes this, because the queue is idle.
    if (guardianReviewQueue.busy) {
      display.show(scope, "queued");
    }
    // Same composite the ask path builds, so Esc and a reviewer-lifecycle reset
    // both release a queued command instead of stranding it behind a review it
    // is no longer waiting for.
    const queueSignal = ctx.signal ? AbortSignal.any([ctx.signal, lifecycleSignal]) : lifecycleSignal;
    let releaseReviewSlot: () => void;
    try {
      releaseReviewSlot = await guardianReviewQueue.acquire(queueSignal);
    } catch {
      return { block: true, reason: "Auto Permissions review cancelled" };
    }
    try {
      if (lifecycleStale() || reviewCancelled(ctx.signal)) {
        return { block: true, reason: "Auto Permissions review cancelled" };
      }
      const signal = ctx.signal;
      display.show(scope, "waiting");
      try {
        const verdict = await reviewer.review(scope, event.input as Record<string, unknown>);
        if (lifecycleStale()) {
          return { block: true, reason: "Auto Permissions review cancelled" };
        }
        if (reviewCancelled(signal)) {
          reviewer.discardLineage();
          if (sessionActive) display.clear(scope);
          return { block: true, reason: "Auto Permissions review cancelled" };
        }
        if (verdict.decision === "approve") {
          const approved = settle(scope, { display: "approved", reason: verdict.reason });
          // An approval ends the argument at this gate: the per-gate bound exists
          // to stop an agent grinding, not to ration a long loop's whole session.
          loopReviseBudget.settle(gate.label);
          return approved;
        }
        // An unattended loop cannot answer a modal and must not be handed an
        // unbounded retry loop either, so both non-approving verdicts come back
        // as one bounded block. The verdict itself is unchanged: nothing is
        // approved here that would not have been approved with a user present.
        const loopContext = detectLoopContext();
        if (loopContext) {
          const charge = chargeLoopRevision(loopContext.loopId, gate.label, verdict.reason);
          return settle(scope, {
            display: verdict.decision === "revise" ? "revise" : "blocked",
            verdict: verdict.decision === "revise" ? "revise" : "block",
            source: "loop",
            reason: verdict.reason,
            block: loopBlockReason({
              gateLabel: gate.label,
              reason: verdict.reason,
              decision: verdict.decision,
              ...charge,
            }),
          });
        }
        if (verdict.decision === "revise") {
          return settle(scope, {
            display: "revise",
            verdict: "revise",
            source: "guardian",
            reason: verdict.reason,
            block: `Auto Permissions requested revision: ${verdict.reason}\nRevise the command and try again.`,
          });
        }
        return askUser(scope, verdict.reason, lifecycleSignal, "guardian");
      } catch (error) {
        if (lifecycleStale() || reviewCancelled(signal)) {
          if (!lifecycleStale() && sessionActive) display.clear(scope);
          return { block: true, reason: "Auto Permissions review cancelled" };
        }
        const reason = error instanceof Error ? error.message : String(error);
        // A review that failed is an infrastructure fault, not a guardian
        // judgment, so it charges no revision round — but it still must not open
        // a modal in a session with nobody to answer it.
        if (detectLoopContext()) {
          return settle(scope, {
            display: "blocked",
            verdict: "block",
            source: "review_failure",
            reason,
            block: `${gate.label} could not be reviewed (${reason}), and this session is running an unattended /loop, so there is no one to ask. Do not retry the same command hoping the reviewer recovers: call loop_wait naming the reviewer failure, or advance the objective another way.`,
          });
        }
        return askUser(scope, `Automatic review failed: ${reason}`, lifecycleSignal, "review_failure");
      }
    } finally {
      releaseReviewSlot();
    }
  });

  pi.registerTool({
    name: "request_override",
    executionMode: "sequential",
    label: "Request Override",
    description: "Request a one-session exception for a command that violates a tooling convention. This cannot bypass guarded commands or deny rules.",
    parameters: Type.Object({
      command: Type.String({ description: "Exact command to allow" }),
      reason: Type.String({ description: "Why the convention does not apply" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let config: AutoPermissionsConfig;
      try {
        config = currentConfig(ctx);
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { success: false },
        };
      }
      const matches = untrustedMatches(params.command, config, trustedGroups);
      if (matches.some((gate) => gate.level === "deny")) {
        return {
          content: [{ type: "text", text: "The command matches a deny rule, which is a hard policy boundary. Deny rules cannot be bypassed with request_override; choose a different approach." }],
          details: { success: false },
        };
      }
      if (!matches.length || matches.some((gate) => gate.level === "guarded")) {
        return {
          content: [{ type: "text", text: "The command is not a convention violation. Guarded commands cannot be bypassed with request_override." }],
          details: { success: false },
        };
      }
      const gate = matches[0];
      const lifecycleSignal = reviewer.lifecycleSignal;
      const lifecycleStale = () => reviewer.isStale(lifecycleSignal);
      const promptSignal = signal ? AbortSignal.any([signal, lifecycleSignal]) : lifecycleSignal;
      const cancelled = () => ({
        content: [{ type: "text" as const, text: "Override cancelled." }],
        details: { success: false },
      });
      if (lifecycleStale() || reviewCancelled(signal)) return cancelled();
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Cannot request an override without an interactive UI." }],
          details: { success: false },
        };
      }

      setHerdrBlocked(pi, true, gate.label);
      try {
        let choice: string | undefined;
        try {
          // The override prompt never had Tab-to-comment (the monkey patch only
          // enabled it on titles matching /needs approval/i), so keep parity.
          choice = await promptSelect(
            pi,
            ctx,
            `Convention override: ${gate.label}\n\n${params.reason}\n\n${params.command}`,
            ["Allow for this session", "Keep blocked"],
            promptSignal,
            { allowComment: false },
          );
        } catch (error) {
          if (!lifecycleStale() && !reviewCancelled(signal)) throw error;
          return cancelled();
        }
        if (lifecycleStale() || reviewCancelled(signal)) return cancelled();
        if (choice === "Allow for this session") {
          overrides.allowConvention(params.command);
          return {
            content: [{ type: "text", text: `Override granted for this session:\n  ${params.command}` }],
            details: { success: true, command: params.command },
          };
        }
        return {
          content: [{ type: "text", text: gate.message ?? "Use the configured project tooling." }],
          details: { success: false },
        };
      } finally {
        if (!lifecycleStale()) setHerdrBlocked(pi, false);
      }
    },
  });

  // The override schema is useful only after a convention denial has named an
  // exact command. It is kept registered for replay and narrowed out of the
  // active set at session_start — never here, because Pi refuses action methods
  // during extension loading.

  registerSettingsCommand(pi, { overrides, reviewer });

  pi.on("session_shutdown", async (_event, ctx) => {
    sessionActive = false;
    reviewer.abortLifecycle();
    reviewer.discardLineage();
    display.shutdown(ctx);
    setHerdrBlocked(pi, false);
  });

  pi.on("session_start", async (_event, ctx) => {
    overrides.resetForSession();
    warnAboutMissingReviewerProvider(ctx);

    reviewer.abortLifecycle();
    reviewer.discardLineage();
    reviewer.resetLifecycle();
    sessionActive = true;
    overrides.restore(ctx.sessionManager.getBranch());
    // Rebuild the revise budget before the first tool call: a resumed session
    // that forgot its spent rounds would hand the agent a fresh set of them.
    loopReviseBudget.restore(ctx.sessionManager.getBranch());
    loopReviseBudgetLoopId = detectLoopContext()?.loopId;
    trustedGroups = ctx.isProjectTrusted() ? loadTrustedGroups(ctx.cwd) : new Set();
    // Snapshot the trust baseline at session start: remotes configured now are
    // inside the boundary, anything added or repointed later is not. Re-capture
    // on every session_start (resume, branch switch) so the baseline follows
    // the session the reviews belong to; the fingerprint covers the change.
    reviewer.captureEnvironment(ctx.cwd);
    try {
      const config = currentConfig(ctx);
      overrides.loadStanding(config, ctx);
      if (config.ui.placement === "toolRow") display.registerGuardedBash(ctx);
    } catch {
      // The first bash call will fail closed with the configuration error.
    }
  });
}
