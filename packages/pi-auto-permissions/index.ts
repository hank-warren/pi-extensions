import { createReviewLimiter, createReviewQueue } from "./review-queue.js";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  type PromptEvaluationUserChoice,
} from "./evaluation-log.js";
import type { Gate } from "./gates.js";
import { classifyCommand } from "./classify.js";
import type { PermissionVerdict, ReviewEvidenceRecord } from "./review.js";
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
  return `Blocked by policy: ${gate.label}\n\n${gate.message ?? "This operation is denied by rule."}\n\nThis is a deny rule: it cannot be overridden by trusted groups or user approval. Choose a different approach.`;
}

function reviewCancelledResult(): BlockResult {
  return { block: true, reason: "Auto Permissions review cancelled" };
}

function withLifecycle(signal: AbortSignal | undefined, lifecycle: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, lifecycle]) : lifecycle;
}

/**
 * Settle with `promise`, or reject as soon as `signal` aborts. The promise is
 * left to finish on its own; its outcome is then ignored.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Aborts when the turn ends or, for a codemode call, when its script does. */
function callSignalOf(scope: ReviewScope): AbortSignal | undefined {
  const { ctx, callSignal } = scope;
  if (!callSignal) return ctx.signal;
  return ctx.signal ? AbortSignal.any([ctx.signal, callSignal]) : callSignal;
}

/** How one guardian review ended, before its verdict is applied. */
type ReviewAttempt =
  | { kind: "verdict"; verdict: PermissionVerdict; evidenceKeys: string[] }
  | { kind: "failed"; reason: string; evidenceKeys: string[] }
  | { kind: "cancelled" };

/**
 * A verdict whose evidence changed while it waited (the user answered another
 * command's prompt, a tool result landed) is reviewed again before it is
 * applied. Bounded so evidence that never settles cannot loop forever: the
 * last review runs holding the decision slot, so no other prompt can be
 * answered while it runs, which is the staleness window a lone review has
 * always had.
 */
const MAX_REVIEWS_PER_COMMAND = 3;

/** How many finished call ids are remembered for calls a script left behind. */
const MAX_FINISHED_CALLS = 1024;

/** Abort reason for an early review replaced by a fresh one for the same call. */
const SUPERSEDED_REVIEW = "auto-permissions: superseded review";

/** A review started early for a later bash call in the same assistant message. */
interface SiblingReview {
  scope: ReviewScope;
  input: string;
  gateLabel: string;
  attempt: Promise<ReviewAttempt>;
  controller: AbortController;
}

interface AssistantToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

function isBashTool(name: string): boolean {
  return name === "bash" || name.endsWith(".bash");
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function assistantToolCalls(message: unknown): AssistantToolCall[] {
  const candidate = message as { role?: unknown; content?: unknown } | undefined;
  if (candidate?.role !== "assistant" || !Array.isArray(candidate.content)) return [];
  return candidate.content.flatMap((block) => {
    const call = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown } | undefined;
    return call?.type === "toolCall" && typeof call.id === "string" && typeof call.name === "string"
      ? [{ id: call.id, name: call.name, arguments: call.arguments }]
      : [];
  });
}

export default function autoPermissionsExtension(pi: ExtensionAPI) {
  const overrides = createSessionOverrides(pi);
  let trustedGroups = new Set<string>();
  let lastConfigError: string | undefined;
  let lastEvaluationLogError: string | undefined;
  // Guardian calls run in parallel up to config.reviewConcurrency; applying
  // verdicts and prompting the user stay one command at a time.
  const reviewSlots = createReviewLimiter();
  const decisionQueue = createReviewQueue();
  // Pi runs tool_call handlers for one assistant message's calls one after
  // another, so the later bash calls' reviews are started early from here.
  let lastAssistantCalls: AssistantToolCall[] = [];
  const siblingReviews = new Map<string, SiblingReview>();
  // One controller per tool call (a codemode script) that has made bash calls,
  // aborted when Pi reports that call finished: its pending calls can no
  // longer run, so their reviews and prompts are released.
  const scriptsEnded = new Map<string, AbortController>();
  // Calls that already finished, newest last. A script can end before Pi runs
  // the tool_call hook of a call it fired without awaiting, and with sequential
  // tool execution that hook can run after the turn is over, so this outlives
  // the turn. Bounded: only a recently finished call can still have one pending.
  const finishedCalls = new Set<string>();
  // Nested call id → the model-issued call it descends from, so a call made
  // several levels down still names the script whose SCRIPT record it shares.
  const scriptRoots = new Map<string, string>();

  function rememberFinished(toolCallId: string): void {
    finishedCalls.delete(toolCallId);
    finishedCalls.add(toolCallId);
    if (finishedCalls.size > MAX_FINISHED_CALLS) {
      finishedCalls.delete(finishedCalls.values().next().value!);
    }
  }

  function callEndedSignal(toolCallId: string): AbortSignal {
    if (finishedCalls.has(toolCallId)) return AbortSignal.abort();
    let controller = scriptsEnded.get(toolCallId);
    if (!controller) {
      controller = new AbortController();
      scriptsEnded.set(toolCallId, controller);
    }
    return controller.signal;
  }

  /**
   * Aborts when the call that made this one ends, or the script at the top of
   * the chain does: a tool in between may keep awaiting this call after its
   * script has gone.
   */
  function scriptEndedSignal(parentToolCallId: string, scriptToolCallId: string): AbortSignal {
    const parent = callEndedSignal(parentToolCallId);
    return scriptToolCallId === parentToolCallId
      ? parent
      : AbortSignal.any([parent, callEndedSignal(scriptToolCallId)]);
  }

  function endScripts(): void {
    for (const controller of scriptsEnded.values()) controller.abort();
    scriptsEnded.clear();
  }
  // The session is active exactly while the reviewer lifecycle is unaborted:
  // session_shutdown aborts it, session_start synchronously aborts and replaces
  // it, and nothing else touches it.
  const reviewer = createGuardianReviewer({ overrides });
  const display = createReviewDisplay({ isSessionActive: () => !reviewer.lifecycleSignal.aborted });

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
  function warnAboutMissingReviewerProvider(ctx: ExtensionContext, config: AutoPermissionsConfig): void {
    const provider = config.reviewer?.provider;
    if (!provider || ctx.modelRegistry.getProvider(provider)) return;

    const message =
      `reviewer provider "${provider}" is not registered. Install @hank-warren/pi-multi-login to` +
      ` provide additional logins such as this one, or point reviewer.provider at a signed-in provider.`;
    console.warn(`[pi-auto-permissions] ${message}`);
    ctx.ui.notify(`Auto Permissions: ${message}`, "warning");
  }

  function reviewCancelled(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
  }

  /**
   * A cancelled turn resets the reviewer lineage. A codemode script ending
   * does not: the reviewer conversation is intact, and dropping it would make
   * the next reviews start cold.
   */
  function discardLineageIfTurnCancelled(scope: ReviewScope): void {
    if (reviewCancelled(scope.ctx.signal)) reviewer.discardLineage();
  }

  function cancelledAfterAwait(scope: ReviewScope, lifecycleSignal: AbortSignal): BlockResult | undefined {
    if (reviewer.isStale(lifecycleSignal)) return reviewCancelledResult();
    if (!reviewCancelled(callSignalOf(scope))) return undefined;
    discardLineageIfTurnCancelled(scope);
    display.clear(scope);
    return reviewCancelledResult();
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

  async function askUser(
    scope: ReviewScope,
    detail: string,
    lifecycleSignal: AbortSignal,
    decisionSource: "guardian" | "review_failure",
  ): Promise<BlockResult | undefined> {
    const { ctx, config, gate, command } = scope;
    const signal = callSignalOf(scope);
    const lifecycleStale = () => reviewer.isStale(lifecycleSignal);
    const promptSignal = withLifecycle(signal, lifecycleSignal);
    const cancelled = reviewCancelledResult;
    if (lifecycleStale() || reviewCancelled(signal)) {
      if (!lifecycleStale()) discardLineageIfTurnCancelled(scope);
      return cancelled();
    }
    display.show(scope, "ask_user", detail);
    if (!ctx.hasUI) {
      return settle(scope, {
        display: "blocked",
        verdict: "block",
        source: decisionSource,
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
          permissionPromptOptions(config.evaluationLog.enabled),
          promptSignal,
        );
      } catch (error) {
        if (!lifecycleStale() && !reviewCancelled(signal)) throw error;
        if (!lifecycleStale()) discardLineageIfTurnCancelled(scope);
        return cancelled();
      }
      const cancelledResult = cancelledAfterAwait(scope, lifecycleSignal);
      if (cancelledResult) return cancelledResult;
      const classification = classifyPromptChoice(choice);
      // Feed the user's decision back to the guardian as session-scoped
      // user-source evidence. review_failure prompts are excluded: their
      // "concern" is an infrastructure error, not a guardian judgment.
      if (decisionSource === "guardian" && classification) {
        overrides.recordPromptDecision(gate, command, classification, detail, reviewer.lastEvidenceKey);
      }
      if (classification?.userChoice) {
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

  function evidenceKeys(scope: ReviewScope): string[] {
    return reviewer.collectEvidence(scope).map((record) => record.key);
  }

  /**
   * One guardian review, run as soon as a review slot is free. Never applies
   * the verdict: that waits for the decision slot in `decide`.
   *
   * `abandon` is set for a sibling review started early. Aborting it drops the
   * verdict; its row is cleared too, unless the abort reason is
   * `SUPERSEDED_REVIEW`, meaning a fresh review for the same call owns the row.
   */
  async function runReview(
    scope: ReviewScope,
    input: Record<string, unknown>,
    lifecycleSignal: AbortSignal,
    abandon?: AbortSignal,
  ): Promise<ReviewAttempt> {
    const { ctx, config } = scope;
    const lifecycleStale = () => reviewer.isStale(lifecycleSignal);
    const abandoned = () => abandon?.aborted === true;
    const drop = (): ReviewAttempt => {
      if (!lifecycleStale() && abandon?.reason !== SUPERSEDED_REVIEW) display.clear(scope);
      return { kind: "cancelled" };
    };
    const callSignal = callSignalOf(scope);
    const slotSignal = AbortSignal.any([
      lifecycleSignal,
      ...(callSignal ? [callSignal] : []),
      ...(abandon ? [abandon] : []),
    ]);
    if (reviewSlots.wouldWait(config.reviewConcurrency)) display.show(scope, "queued");
    let releaseSlot: () => void;
    try {
      releaseSlot = await reviewSlots.acquire(config.reviewConcurrency, slotSignal);
    } catch {
      return drop();
    }
    try {
      if (lifecycleStale() || reviewCancelled(callSignal) || abandoned()) return drop();
      display.show(scope, "waiting");
      // Collected synchronously right before the review collects the same
      // stream, so the keys describe exactly what the guardian judged.
      const keys = evidenceKeys(scope);
      let attempt: ReviewAttempt;
      try {
        // The reviewer already follows the turn signal. A codemode call whose
        // script ended, or an early review nobody will take, cancels its
        // request and gives its slot back at once.
        const stop = scope.callSignal && abandon
          ? AbortSignal.any([scope.callSignal, abandon])
          : scope.callSignal ?? abandon;
        const review = reviewer.review(scope, input, stop);
        const verdict = await (stop ? untilAborted(review, stop) : review);
        if (!lifecycleStale() && reviewCancelled(ctx.signal)) reviewer.discardLineage();
        attempt = { kind: "verdict", verdict, evidenceKeys: keys };
      } catch (error) {
        attempt = { kind: "failed", reason: error instanceof Error ? error.message : String(error), evidenceKeys: keys };
      }
      if (lifecycleStale() || reviewCancelled(callSignal) || abandoned()) return drop();
      // An early sibling review now waits for Pi to reach its call.
      if (abandon) display.show(scope, "queued");
      return attempt;
    } finally {
      releaseSlot();
    }
  }

  /** Apply one settled review. Runs holding the decision slot. */
  function applyReview(
    scope: ReviewScope,
    outcome: Exclude<ReviewAttempt, { kind: "cancelled" }>,
    lifecycleSignal: AbortSignal,
  ): Promise<BlockResult | undefined> | BlockResult | undefined {
    if (outcome.kind === "failed") {
      return askUser(scope, `Automatic review failed: ${outcome.reason}`, lifecycleSignal, "review_failure");
    }
    const { verdict } = outcome;
    if (verdict.decision === "approve") {
      return settle(scope, { display: "approved", reason: verdict.reason });
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
  }

  /**
   * Wait for a review, then apply it in the decision slot, one command at a
   * time. The slot spans any approval prompt, so a verdict reached while the
   * user was answering another command's prompt is checked against the
   * evidence that answer added, and reviewed again when it changed. The last
   * review `MAX_REVIEWS_PER_COMMAND` allows runs inside the slot.
   */
  async function decide(
    scope: ReviewScope,
    input: Record<string, unknown>,
    lifecycleSignal: AbortSignal,
    firstAttempt: Promise<ReviewAttempt>,
  ): Promise<BlockResult | undefined> {
    const lifecycleStale = () => reviewer.isStale(lifecycleSignal);
    const callSignal = callSignalOf(scope);
    // Same composite the ask path builds, so Esc, a reviewer-lifecycle reset
    // and the end of a codemode script all release a waiting command instead
    // of stranding it behind a prompt it is no longer waiting for.
    const queueSignal = withLifecycle(callSignal, lifecycleSignal);
    let attempt = firstAttempt;
    for (let reviews = 1; ; reviews += 1) {
      const outcome = await attempt;
      if (outcome.kind === "cancelled") return reviewCancelledResult();
      if (decisionQueue.busy) display.show(scope, "queued");
      let releaseDecision: () => void;
      try {
        releaseDecision = await decisionQueue.acquire(queueSignal);
      } catch {
        if (!lifecycleStale()) display.clear(scope);
        return reviewCancelledResult();
      }
      try {
        if (lifecycleStale() || reviewCancelled(callSignal)) {
          if (!lifecycleStale()) display.clear(scope);
          return reviewCancelledResult();
        }
        if (sameKeys(outcome.evidenceKeys, evidenceKeys(scope))) {
          return await applyReview(scope, outcome, lifecycleSignal);
        }
        if (reviews + 1 < MAX_REVIEWS_PER_COMMAND) {
          attempt = runReview(scope, input, lifecycleSignal);
          continue;
        }
        const last = await runReview(scope, input, lifecycleSignal);
        if (last.kind === "cancelled") return reviewCancelledResult();
        return await applyReview(scope, last, lifecycleSignal);
      } finally {
        releaseDecision();
      }
    }
  }

  /**
   * Start reviews for the guarded bash calls that follow `toolCallId` in the
   * assistant message that issued it. Pi calls tool_call handlers for one
   * message's calls one at a time, so without this their reviews could never
   * overlap. Each result is taken by the call's own handler, and only when the
   * input it finally receives is exactly the input that was reviewed.
   */
  function startSiblingReviews(
    toolCallId: string,
    ctx: ExtensionContext,
    config: AutoPermissionsConfig,
    lifecycleSignal: AbortSignal,
  ): void {
    if (config.reviewConcurrency <= 1) return;
    const index = lastAssistantCalls.findIndex((call) => call.id === toolCallId);
    if (index < 0) return;
    for (const call of lastAssistantCalls.slice(index + 1)) {
      if (!isBashTool(call.name) || siblingReviews.has(call.id)) continue;
      const input = call.arguments as Record<string, unknown> | undefined;
      const command = input?.command;
      if (typeof command !== "string") continue;
      const classified = classifyCommand(command, config, trustedGroups);
      if (classified.kind !== "review") continue;
      const controller = new AbortController();
      const scope: ReviewScope = {
        ctx,
        config,
        gate: classified.gate,
        command,
        target: { toolName: call.name, toolCallId: call.id },
      };
      siblingReviews.set(call.id, {
        scope,
        input: JSON.stringify(input),
        gateLabel: classified.gate.label,
        attempt: runReview(scope, input!, lifecycleSignal, controller.signal),
        controller,
      });
    }
  }

  /**
   * The early review of this call, when it reviewed exactly this input under
   * this gate. `gateLabel` is undefined when the call no longer needs review
   * (another handler changed it), in which case the early review is dropped.
   */
  function takeSiblingReview(
    toolCallId: string,
    input: unknown,
    gateLabel: string | undefined,
  ): Promise<ReviewAttempt> | undefined {
    const sibling = siblingReviews.get(toolCallId);
    if (!sibling) return undefined;
    siblingReviews.delete(toolCallId);
    if (gateLabel === undefined) {
      sibling.controller.abort();
      display.clear(sibling.scope);
      return undefined;
    }
    if (sibling.input === JSON.stringify(input) && sibling.gateLabel === gateLabel) return sibling.attempt;
    // Changed after it was reviewed early: the fresh review owns the row.
    sibling.controller.abort(SUPERSEDED_REVIEW);
    return undefined;
  }

  /** Drop early reviews whose calls never reached this extension. */
  function abandonSiblingReviews(): void {
    for (const sibling of siblingReviews.values()) {
      sibling.controller.abort();
      display.clear(sibling.scope);
    }
    siblingReviews.clear();
  }

  pi.on("message_end", (event) => {
    const calls = assistantToolCalls((event as { message?: unknown }).message);
    if (calls.length > 0) lastAssistantCalls = calls;
  });

  pi.on("turn_end", () => {
    lastAssistantCalls = [];
    abandonSiblingReviews();
    endScripts();
    scriptRoots.clear();
  });

  pi.on("tool_execution_start", (event) => {
    const { toolCallId, parentToolCallId } = event as { toolCallId?: unknown; parentToolCallId?: unknown };
    if (typeof toolCallId !== "string") return;
    // A provider may reuse a call id in a later turn; that call is live again.
    finishedCalls.delete(toolCallId);
    if (typeof parentToolCallId === "string") {
      scriptRoots.set(toolCallId, scriptRoots.get(parentToolCallId) ?? parentToolCallId);
    }
  });

  pi.on("tool_execution_end", (event) => {
    const { toolCallId } = event as { toolCallId?: unknown };
    if (typeof toolCallId !== "string") return;
    rememberFinished(toolCallId);
    const controller = scriptsEnded.get(toolCallId);
    if (!controller) return;
    scriptsEnded.delete(toolCallId);
    controller.abort();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isBashTool(event.toolName)) return;
    const command = (event.input as { command: string }).command;
    const lifecycleSignal = reviewer.lifecycleSignal;

    let config: AutoPermissionsConfig;
    try {
      config = currentConfig(ctx);
    } catch (error) {
      reviewer.discardLineage();
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
    if (!config.enabled) return;
    const parentToolCallId = (event as { parentToolCallId?: string }).parentToolCallId;
    if (!parentToolCallId) startSiblingReviews(event.toolCallId, ctx, config, lifecycleSignal);
    const scriptToolCallId = parentToolCallId ? scriptRoots.get(parentToolCallId) ?? parentToolCallId : undefined;
    const target: ReviewTarget = {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      ...(scriptToolCallId ? { scriptToolCallId } : {}),
    };
    const input = event.input as Record<string, unknown>;
    const classified = classifyCommand(command, config, trustedGroups);
    const early = takeSiblingReview(
      event.toolCallId,
      input,
      classified.kind === "review" ? classified.gate.label : undefined,
    );
    if (classified.kind === "pass") return;
    const gate = classified.gate;
    const scope: ReviewScope = {
      ctx,
      config,
      gate,
      command,
      target,
      ...(parentToolCallId && scriptToolCallId
        ? { callSignal: scriptEndedSignal(parentToolCallId, scriptToolCallId) }
        : {}),
    };
    if (classified.kind === "deny") {
      return settle(scope, {
        verdict: "block",
        source: "deny",
        reason: gate.message ?? gate.label,
        block: denyReason(gate),
      });
    }

    return decide(scope, input, lifecycleSignal, early ?? runReview(scope, input, lifecycleSignal));
  });

  registerSettingsCommand(pi, { overrides, reviewer });

  function resetCallTracking(): void {
    lastAssistantCalls = [];
    abandonSiblingReviews();
    endScripts();
    finishedCalls.clear();
    scriptRoots.clear();
  }

  pi.on("session_shutdown", async (_event, ctx) => {
    resetCallTracking();
    reviewer.endSession();
    display.shutdown(ctx);
    setHerdrBlocked(pi, false);
  });

  pi.on("session_start", async (_event, ctx) => {
    let config: AutoPermissionsConfig | undefined;
    try {
      config = currentConfig(ctx);
    } catch {
      // Reported by currentConfig; the first bash call fails closed.
    }
    if (config) warnAboutMissingReviewerProvider(ctx, config);

    resetCallTracking();
    reviewer.startSession(ctx.cwd);
    overrides.restore(ctx.sessionManager.getBranch());
    trustedGroups = ctx.isProjectTrusted() ? loadTrustedGroups(ctx.cwd) : new Set();
  });
}
