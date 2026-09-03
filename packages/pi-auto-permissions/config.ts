import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Gate, GateLevel } from "./gates.js";
import { DEFAULT_RULES } from "./default-rules.js";
import { AUTO_PERMISSIONS_SYSTEM_PROMPT } from "./review.js";

export const CONFIG_FILENAME = "pi-auto-permissions/config.json";

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

/** Loader defaults for an incomplete `reviewer` block, shared with the settings UI. */
export const DEFAULT_REVIEWER_REASONING_EFFORT: ReasoningEffort = "low";
export const DEFAULT_REVIEWER_TIMEOUT_MS = 30_000;
export const MIN_REVIEWER_TIMEOUT_MS = 1_000;
export const MAX_REVIEWER_TIMEOUT_MS = 300_000;

/**
 * Where the active reviewer system prompt came from. The settings UI shows this
 * (read-only) so the resolved `systemPromptFile` path is visible without having
 * to re-derive the loader's relative-path resolution by hand.
 */
export type SystemPromptSource =
  | { kind: "builtin" }
  | { kind: "inline" }
  | { kind: "file"; path: string };

export interface AutoPermissionsConfig {
  enabled: boolean;
  reviewer?: {
    provider: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    timeoutMs: number;
    /**
     * Two-stage review: a stateless single-token SAFE/REVIEW pass at minimal
     * reasoning before the full lineage review. SAFE approves; REVIEW and
     * every parse or infrastructure failure fall through to the full review
     * (fail closed). Opt-in until evaluation-log data justifies default-on;
     * recommended together with `reviewAllShell`.
     */
    prefilter: boolean;
  };
  systemPrompt: string;
  systemPromptSource: SystemPromptSource;
  reviewEvidence: {
    projectInstructions: boolean;
    userAnswerTools: string[];
    /**
     * `custom_message` customTypes whose content counts as user-source
     * evidence.
     *
     * Extensions inject context with `appendCustomMessageEntry`, and Pi turns
     * that content into a user message for the model — but the session entry
     * is a `custom_message`, not a message with a role, so the evidence
     * collector never saw it. The model read the text as the user's; the
     * reviewer read nothing at all.
     *
     * pi-loop's objective is the case that matters: user-typed or
     * user-approved, frozen at start, and the whole reason the session is
     * doing what it is doing. Reviewing a looping session without it means
     * refusing work the user explicitly asked for — observed live, on a
     * `git worktree add` whose objective said "in a worktree branched off
     * origin/main".
     *
     * An allowlist rather than "project every custom message", for the same
     * reason `userAnswerTools` is one: any installed extension can append a
     * custom message, and a blanket rule would let any of them mint user
     * authorization. Naming the types keeps that an explicit choice.
     */
    userMessageTypes: string[];
    /** Per-record caps at evidence creation; 0 disables. User records are never truncated. */
    toolRecordMaxChars: number;
    assistantRecordMaxChars: number;
    compactionRecordMaxChars: number;
    /** On full envelope rebuilds, collapse all but the newest N tool records; 0 disables. */
    fullRebuildKeepToolRecords: number;
  };
  evaluationLog: {
    enabled: boolean;
    path: string;
  };
  usageLog: {
    enabled: boolean;
    path: string;
  };
  /** Every non-approved outcome, for the Recent denials view. Default on. */
  denialLog: {
    enabled: boolean;
    path: string;
  };
  /** User-granted comparable-command approvals, shared across projects. Default on. */
  standingApprovals: {
    enabled: boolean;
    path: string;
  };
  rules: Gate[];
  /**
   * Review every bash command that matches no rule under the generic
   * `shell command` gate (`ALL_SHELL_GATE`). Default false: the ruleset is
   * the reviewed surface. The trade is deliberate and mirrors Claude Code's
   * `classifyAllShell` — full coverage for one guardian call per command.
   */
  reviewAllShell: boolean;
  /**
   * Prose trust configuration, appended to the reviewer policy prompt as a
   * labeled section (outside `systemPrompt`, so customized prompt files still
   * receive it). Entries are natural-language rules — "write them the way you
   * would describe your infrastructure to a new engineer" — mirroring Claude
   * Code's `autoMode.environment`/`allow`/`soft_deny`/`hard_deny`.
   *
   * Each list is independent: setting one leaves the others (and the built-in
   * decision table, which stays the default policy) intact. Deliberately
   * user-scoped-config only — no project-file read — closing by construction
   * the checked-in-file injection hole CC patched in v2.1.207.
   */
  guardianPolicy: {
    environment: string[];
    allow: string[];
    softDeny: string[];
    hardDeny: string[];
  };
  ui: {
    enabled: boolean;
    resultDisplayMs: number;
    placement: "widget" | "toolRow";
  };
}

interface RuleInput {
  pattern?: unknown;
  flags?: unknown;
  level?: unknown;
  group?: unknown;
  label?: unknown;
  message?: unknown;
}

/**
 * The single config location, honouring the `PI_AUTO_PERMISSIONS_CONFIG`
 * override. Exported so the settings writer can never target a different file
 * than the loader reads.
 */
export function autoPermissionsConfigPath(): string {
  return process.env.PI_AUTO_PERMISSIONS_CONFIG
    ? resolve(process.env.PI_AUTO_PERMISSIONS_CONFIG)
    : join(getAgentDir(), CONFIG_FILENAME);
}

function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("auto permissions config must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function compileRule(value: unknown, index: number): Gate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`rules[${index}] must be an object`);
  }
  const input = value as RuleInput;
  const pattern = optionalString(input.pattern, `rules[${index}].pattern`);
  const group = optionalString(input.group, `rules[${index}].group`);
  const label = optionalString(input.label, `rules[${index}].label`);
  if (!pattern || !group || !label) throw new Error(`rules[${index}] requires pattern, group, and label`);
  const flags = input.flags === undefined ? "i" : input.flags;
  if (typeof flags !== "string") throw new Error(`rules[${index}].flags must be a string`);
  const level: GateLevel = input.level === undefined ? "guarded" : input.level as GateLevel;
  if (level !== "guarded" && level !== "convention" && level !== "deny") {
    throw new Error(`rules[${index}].level must be guarded, convention, or deny`);
  }
  const message = optionalString(input.message, `rules[${index}].message`);
  if ((level === "convention" || level === "deny") && !message) {
    throw new Error(`rules[${index}].message is required for ${level} rules`);
  }

  return {
    pattern: new RegExp(pattern, flags),
    level,
    group,
    label,
    message,
  };
}

/** The literal a `rules` array uses to splice the built-in ruleset in place. */
const DEFAULT_RULES_TOKEN = "$defaults";

/**
 * Compile an authored `rules` array, splicing `defaults` wherever the literal
 * string `"$defaults"` appears (mirroring Claude Code's splice semantics: the
 * built-ins keep updating across releases, and custom entries can sit before
 * or after them). The token may appear at most once — a second occurrence is
 * far more likely a copy-paste error than a request for double gating.
 *
 * The caller handles the other two shapes: an absent `rules` key means the
 * defaults are active, and an authored array without the token is a full
 * replacement (an explicit `[]` gates nothing).
 */
export function expandRules(rawRules: readonly unknown[], defaults: readonly Gate[]): Gate[] {
  const rules: Gate[] = [];
  let spliced = false;
  for (let index = 0; index < rawRules.length; index++) {
    const value = rawRules[index];
    if (value === DEFAULT_RULES_TOKEN) {
      if (spliced) throw new Error(`rules may contain "${DEFAULT_RULES_TOKEN}" at most once`);
      spliced = true;
      rules.push(...defaults);
      continue;
    }
    rules.push(compileRule(value, index));
  }
  return rules;
}

function resolvePrompt(
  raw: Record<string, unknown>,
  path: string,
): { prompt: string; source: SystemPromptSource } {
  const inline = optionalString(raw.systemPrompt, "systemPrompt");
  const file = optionalString(raw.systemPromptFile, "systemPromptFile");
  if (inline && file) throw new Error("set only one of systemPrompt and systemPromptFile");
  if (inline) return { prompt: inline, source: { kind: "inline" } };
  if (!file) return { prompt: AUTO_PERMISSIONS_SYSTEM_PROMPT, source: { kind: "builtin" } };

  const expanded = file.startsWith("~/") ? join(homedir(), file.slice(2)) : file;
  const resolved = isAbsolute(expanded) ? expanded : resolve(dirname(path), expanded);
  const prompt = readFileSync(resolved, "utf8").trim();
  if (!prompt) throw new Error("systemPromptFile is empty");
  return { prompt, source: { kind: "file", path: resolved } };
}

/**
 * The one injected message type trusted out of the box.
 *
 * pi-loop's kickoff anchor (`LOOP_ANCHOR_MESSAGE_TYPE`), which carries the
 * objective the user typed or approved. Named as a plain string, the way
 * `loop-context.ts` names `PI_LOOP_ACTIVE`: no import, no dependency, and no
 * behaviour at all when pi-loop is not installed.
 */
const DEFAULT_USER_MESSAGE_TYPES = ["loop-objective"] as const;

const EVIDENCE_PRUNING_DEFAULTS = {
  toolRecordMaxChars: 500,
  assistantRecordMaxChars: 1000,
  compactionRecordMaxChars: 4000,
  fullRebuildKeepToolRecords: 60,
} as const;

function resolvePruningKnob(evidence: Record<string, unknown>, name: keyof typeof EVIDENCE_PRUNING_DEFAULTS): number {
  const value = evidence[name];
  if (value === undefined) return EVIDENCE_PRUNING_DEFAULTS[name];
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 1_000_000) {
    throw new Error(`reviewEvidence.${name} must be an integer between 0 and 1000000`);
  }
  return Number(value);
}

function resolveReviewEvidence(raw: Record<string, unknown>): AutoPermissionsConfig["reviewEvidence"] {
  if (raw.reviewEvidence === undefined) {
    return {
      projectInstructions: false,
      userAnswerTools: [],
      userMessageTypes: [...DEFAULT_USER_MESSAGE_TYPES],
      ...EVIDENCE_PRUNING_DEFAULTS,
    };
  }
  if (!raw.reviewEvidence || typeof raw.reviewEvidence !== "object" || Array.isArray(raw.reviewEvidence)) {
    throw new Error("reviewEvidence must be an object");
  }
  const evidence = raw.reviewEvidence as Record<string, unknown>;
  if (evidence.projectInstructions !== undefined && typeof evidence.projectInstructions !== "boolean") {
    throw new Error("reviewEvidence.projectInstructions must be boolean");
  }
  const rawTools = evidence.userAnswerTools === undefined ? [] : evidence.userAnswerTools;
  if (!Array.isArray(rawTools) || rawTools.some((tool) => typeof tool !== "string" || !tool.trim())) {
    throw new Error("reviewEvidence.userAnswerTools must be an array of non-empty strings");
  }
  // Absent means the default, and an explicit empty array means none: a user
  // who wants the loop objective out of the envelope must be able to say so,
  // and cannot if omission and `[]` are the same thing.
  const rawMessageTypes = evidence.userMessageTypes === undefined
    ? [...DEFAULT_USER_MESSAGE_TYPES]
    : evidence.userMessageTypes;
  if (
    !Array.isArray(rawMessageTypes)
    || rawMessageTypes.some((type) => typeof type !== "string" || !type.trim())
  ) {
    throw new Error("reviewEvidence.userMessageTypes must be an array of non-empty strings");
  }
  return {
    projectInstructions: evidence.projectInstructions === true,
    userAnswerTools: [...new Set((rawTools as string[]).map((tool) => tool.trim()))],
    userMessageTypes: [...new Set((rawMessageTypes as string[]).map((type) => type.trim()))],
    toolRecordMaxChars: resolvePruningKnob(evidence, "toolRecordMaxChars"),
    assistantRecordMaxChars: resolvePruningKnob(evidence, "assistantRecordMaxChars"),
    compactionRecordMaxChars: resolvePruningKnob(evidence, "compactionRecordMaxChars"),
    fullRebuildKeepToolRecords: resolvePruningKnob(evidence, "fullRebuildKeepToolRecords"),
  };
}

function resolveEvaluationLog(
  raw: Record<string, unknown>,
  configFilePath: string,
): AutoPermissionsConfig["evaluationLog"] {
  const defaultPath = resolve(dirname(configFilePath), "review-evals.jsonl");
  if (raw.evaluationLog === undefined) return { enabled: false, path: defaultPath };
  if (!raw.evaluationLog || typeof raw.evaluationLog !== "object" || Array.isArray(raw.evaluationLog)) {
    throw new Error("evaluationLog must be an object");
  }
  const evaluationLog = raw.evaluationLog as Record<string, unknown>;
  if (evaluationLog.enabled !== undefined && typeof evaluationLog.enabled !== "boolean") {
    throw new Error("evaluationLog.enabled must be boolean");
  }
  const configuredPath = optionalString(evaluationLog.path, "evaluationLog.path");
  if (!configuredPath) return { enabled: evaluationLog.enabled === true, path: defaultPath };
  const expanded = configuredPath.startsWith("~/") ? join(homedir(), configuredPath.slice(2)) : configuredPath;
  return {
    enabled: evaluationLog.enabled === true,
    path: isAbsolute(expanded) ? expanded : resolve(dirname(configFilePath), expanded),
  };
}

function resolveUsageLog(
  raw: Record<string, unknown>,
  configFilePath: string,
): AutoPermissionsConfig["usageLog"] {
  const defaultPath = resolve(dirname(configFilePath), "usage.jsonl");
  if (raw.usageLog === undefined) return { enabled: true, path: defaultPath };
  if (!raw.usageLog || typeof raw.usageLog !== "object" || Array.isArray(raw.usageLog)) {
    throw new Error("usageLog must be an object");
  }
  const usageLog = raw.usageLog as Record<string, unknown>;
  if (usageLog.enabled !== undefined && typeof usageLog.enabled !== "boolean") {
    throw new Error("usageLog.enabled must be boolean");
  }
  const enabled = usageLog.enabled !== false;
  const configuredPath = optionalString(usageLog.path, "usageLog.path");
  if (!configuredPath) return { enabled, path: defaultPath };
  const expanded = configuredPath.startsWith("~/") ? join(homedir(), configuredPath.slice(2)) : configuredPath;
  return { enabled, path: isAbsolute(expanded) ? expanded : resolve(dirname(configFilePath), expanded) };
}

const GUARDIAN_POLICY_KEYS = ["environment", "allow", "softDeny", "hardDeny"] as const;

function resolveGuardianPolicy(raw: Record<string, unknown>): AutoPermissionsConfig["guardianPolicy"] {
  const empty = { environment: [], allow: [], softDeny: [], hardDeny: [] };
  if (raw.guardianPolicy === undefined) return empty;
  if (!raw.guardianPolicy || typeof raw.guardianPolicy !== "object" || Array.isArray(raw.guardianPolicy)) {
    throw new Error("guardianPolicy must be an object");
  }
  const policy = raw.guardianPolicy as Record<string, unknown>;
  for (const key of Object.keys(policy)) {
    if (!(GUARDIAN_POLICY_KEYS as readonly string[]).includes(key)) {
      throw new Error(`guardianPolicy.${key} is not a recognized list (use environment, allow, softDeny, hardDeny)`);
    }
  }
  const resolveList = (key: typeof GUARDIAN_POLICY_KEYS[number]): string[] => {
    const value = policy[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new Error(`guardianPolicy.${key} must be an array of non-empty strings`);
    }
    return [...new Set((value as string[]).map((entry) => entry.trim()))];
  };
  return {
    environment: resolveList("environment"),
    allow: resolveList("allow"),
    softDeny: resolveList("softDeny"),
    hardDeny: resolveList("hardDeny"),
  };
}

function resolveDenialLog(
  raw: Record<string, unknown>,
  configFilePath: string,
): AutoPermissionsConfig["denialLog"] {
  const defaultPath = resolve(dirname(configFilePath), "denials.jsonl");
  if (raw.denialLog === undefined) return { enabled: true, path: defaultPath };
  if (!raw.denialLog || typeof raw.denialLog !== "object" || Array.isArray(raw.denialLog)) {
    throw new Error("denialLog must be an object");
  }
  const denialLog = raw.denialLog as Record<string, unknown>;
  if (denialLog.enabled !== undefined && typeof denialLog.enabled !== "boolean") {
    throw new Error("denialLog.enabled must be boolean");
  }
  const enabled = denialLog.enabled !== false;
  const configuredPath = optionalString(denialLog.path, "denialLog.path");
  if (!configuredPath) return { enabled, path: defaultPath };
  const expanded = configuredPath.startsWith("~/") ? join(homedir(), configuredPath.slice(2)) : configuredPath;
  return { enabled, path: isAbsolute(expanded) ? expanded : resolve(dirname(configFilePath), expanded) };
}

function resolveStandingApprovals(
  raw: Record<string, unknown>,
  configFilePath: string,
): AutoPermissionsConfig["standingApprovals"] {
  const defaultPath = resolve(dirname(configFilePath), "standing-approvals.jsonl");
  if (raw.standingApprovals === undefined) return { enabled: true, path: defaultPath };
  if (!raw.standingApprovals || typeof raw.standingApprovals !== "object" || Array.isArray(raw.standingApprovals)) {
    throw new Error("standingApprovals must be an object");
  }
  const standingApprovals = raw.standingApprovals as Record<string, unknown>;
  if (standingApprovals.enabled !== undefined && typeof standingApprovals.enabled !== "boolean") {
    throw new Error("standingApprovals.enabled must be boolean");
  }
  const enabled = standingApprovals.enabled !== false;
  const configuredPath = optionalString(standingApprovals.path, "standingApprovals.path");
  if (!configuredPath) return { enabled, path: defaultPath };
  const expanded = configuredPath.startsWith("~/") ? join(homedir(), configuredPath.slice(2)) : configuredPath;
  return { enabled, path: isAbsolute(expanded) ? expanded : resolve(dirname(configFilePath), expanded) };
}

function resolveUi(raw: Record<string, unknown>): AutoPermissionsConfig["ui"] {
  if (raw.ui === undefined) return { enabled: true, resultDisplayMs: 2500, placement: "widget" };
  if (!raw.ui || typeof raw.ui !== "object" || Array.isArray(raw.ui)) {
    throw new Error("ui must be an object");
  }
  const ui = raw.ui as Record<string, unknown>;
  if (ui.enabled !== undefined && typeof ui.enabled !== "boolean") {
    throw new Error("ui.enabled must be boolean");
  }
  const resultDisplayMs = ui.resultDisplayMs === undefined ? 2500 : ui.resultDisplayMs;
  if (!Number.isInteger(resultDisplayMs) || Number(resultDisplayMs) < 0 || Number(resultDisplayMs) > 30_000) {
    throw new Error("ui.resultDisplayMs must be an integer between 0 and 30000");
  }
  const placement = ui.placement ?? "widget";
  if (placement !== "widget" && placement !== "toolRow") {
    throw new Error("ui.placement must be widget or toolRow");
  }
  return { enabled: ui.enabled !== false, resultDisplayMs: Number(resultDisplayMs), placement };
}

function resolveReviewer(raw: Record<string, unknown>): AutoPermissionsConfig["reviewer"] {
  if (raw.reviewer === undefined) return undefined;
  if (!raw.reviewer || typeof raw.reviewer !== "object" || Array.isArray(raw.reviewer)) {
    throw new Error("reviewer must be an object");
  }
  const reviewer = raw.reviewer as Record<string, unknown>;
  const provider = optionalString(reviewer.provider, "reviewer.provider");
  const model = optionalString(reviewer.model, "reviewer.model");
  if (!provider || !model) throw new Error("reviewer requires both provider and model");
  const reasoningEffort = (optionalString(reviewer.reasoningEffort, "reviewer.reasoningEffort")
    ?? DEFAULT_REVIEWER_REASONING_EFFORT) as ReasoningEffort;
  if (!REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new Error("reviewer.reasoningEffort is invalid");
  }
  const timeoutMs = reviewer.timeoutMs === undefined ? DEFAULT_REVIEWER_TIMEOUT_MS : reviewer.timeoutMs;
  if (
    !Number.isInteger(timeoutMs)
    || Number(timeoutMs) < MIN_REVIEWER_TIMEOUT_MS
    || Number(timeoutMs) > MAX_REVIEWER_TIMEOUT_MS
  ) {
    throw new Error("reviewer.timeoutMs must be an integer between 1000 and 300000");
  }
  if (reviewer.prefilter !== undefined && typeof reviewer.prefilter !== "boolean") {
    throw new Error("reviewer.prefilter must be boolean");
  }
  return {
    provider,
    model,
    reasoningEffort,
    timeoutMs: Number(timeoutMs),
    prefilter: reviewer.prefilter === true,
  };
}

export function loadAutoPermissionsConfig(path = autoPermissionsConfigPath()): AutoPermissionsConfig {
  const raw = readObject(path);
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error("enabled must be boolean");
  if (raw.reviewAllShell !== undefined && typeof raw.reviewAllShell !== "boolean") {
    throw new Error("reviewAllShell must be boolean");
  }
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) throw new Error("rules must be an array");
  // Absent means the built-in ruleset is active; an authored array replaces it
  // entirely unless it splices "$defaults" back in; an explicit [] gates
  // nothing. Existing configs with their own rules keep exactly their rules.
  const rules = raw.rules === undefined ? [...DEFAULT_RULES] : expandRules(raw.rules, DEFAULT_RULES);
  const prompt = resolvePrompt(raw, path);

  return {
    enabled: raw.enabled !== false,
    reviewer: resolveReviewer(raw),
    systemPrompt: prompt.prompt,
    systemPromptSource: prompt.source,
    reviewEvidence: resolveReviewEvidence(raw),
    evaluationLog: resolveEvaluationLog(raw, path),
    usageLog: resolveUsageLog(raw, path),
    denialLog: resolveDenialLog(raw, path),
    standingApprovals: resolveStandingApprovals(raw, path),
    rules,
    reviewAllShell: raw.reviewAllShell === true,
    guardianPolicy: resolveGuardianPolicy(raw),
    ui: resolveUi(raw),
  };
}
