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
     * An allowlist rather than "project every custom message", for the same
     * reason `userAnswerTools` is one: any installed extension can append a
     * custom message, and a blanket rule would let any of them mint user
     * authorization. Naming the types keeps that an explicit choice.
     */
    userMessageTypes: string[];
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

function objectBlock(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return [...new Set((value as string[]).map((entry) => entry.trim()))];
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, name: string): number {
  const v = value === undefined ? fallback : value;
  if (!Number.isInteger(v) || Number(v) < min || Number(v) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return Number(v);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value as boolean | undefined;
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

function resolveConfigRelativePath(value: string, configFilePath: string): string {
  const expanded = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return isAbsolute(expanded) ? expanded : resolve(dirname(configFilePath), expanded);
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

  const resolved = resolveConfigRelativePath(file, path);
  const prompt = readFileSync(resolved, "utf8").trim();
  if (!prompt) throw new Error("systemPromptFile is empty");
  return { prompt, source: { kind: "file", path: resolved } };
}

function resolveReviewEvidence(raw: Record<string, unknown>): AutoPermissionsConfig["reviewEvidence"] {
  const evidence = objectBlock(raw.reviewEvidence, "reviewEvidence") ?? {};
  const projectInstructions = optionalBoolean(evidence.projectInstructions, "reviewEvidence.projectInstructions");
  const userAnswerTools = stringList(evidence.userAnswerTools, "reviewEvidence.userAnswerTools");
  const userMessageTypes = stringList(evidence.userMessageTypes, "reviewEvidence.userMessageTypes");
  return {
    projectInstructions: projectInstructions === true,
    userAnswerTools,
    userMessageTypes,
  };
}

type SidecarKey = "evaluationLog" | "usageLog" | "denialLog" | "standingApprovals";

function resolveSidecar(
  raw: Record<string, unknown>,
  key: SidecarKey,
  fileName: string,
  defaultEnabled: boolean,
  configFilePath: string,
): { enabled: boolean; path: string } {
  const defaultPath = resolve(dirname(configFilePath), fileName);
  const block = objectBlock(raw[key], key);
  if (!block) return { enabled: defaultEnabled, path: defaultPath };
  const enabled = optionalBoolean(block.enabled, `${key}.enabled`) ?? defaultEnabled;
  const configured = optionalString(block.path, `${key}.path`);
  return { enabled, path: configured ? resolveConfigRelativePath(configured, configFilePath) : defaultPath };
}

const GUARDIAN_POLICY_KEYS = ["environment", "allow", "softDeny", "hardDeny"] as const;

function resolveGuardianPolicy(raw: Record<string, unknown>): AutoPermissionsConfig["guardianPolicy"] {
  const empty = { environment: [], allow: [], softDeny: [], hardDeny: [] };
  const policy = objectBlock(raw.guardianPolicy, "guardianPolicy");
  if (!policy) return empty;
  for (const key of Object.keys(policy)) {
    if (!(GUARDIAN_POLICY_KEYS as readonly string[]).includes(key)) {
      throw new Error(`guardianPolicy.${key} is not a recognized list (use environment, allow, softDeny, hardDeny)`);
    }
  }
  const resolveList = (key: typeof GUARDIAN_POLICY_KEYS[number]): string[] =>
    stringList(policy[key], `guardianPolicy.${key}`);
  return {
    environment: resolveList("environment"),
    allow: resolveList("allow"),
    softDeny: resolveList("softDeny"),
    hardDeny: resolveList("hardDeny"),
  };
}

function resolveUi(raw: Record<string, unknown>): AutoPermissionsConfig["ui"] {
  const ui = objectBlock(raw.ui, "ui") ?? {};
  const enabled = optionalBoolean(ui.enabled, "ui.enabled");
  const resultDisplayMs = boundedInteger(ui.resultDisplayMs, 2500, 0, 30_000, "ui.resultDisplayMs");
  const placement = ui.placement ?? "widget";
  if (placement !== "widget" && placement !== "toolRow") {
    throw new Error("ui.placement must be widget or toolRow");
  }
  return { enabled: enabled !== false, resultDisplayMs, placement };
}

function resolveReviewer(raw: Record<string, unknown>): AutoPermissionsConfig["reviewer"] {
  const reviewer = objectBlock(raw.reviewer, "reviewer");
  if (!reviewer) return undefined;
  const provider = optionalString(reviewer.provider, "reviewer.provider");
  const model = optionalString(reviewer.model, "reviewer.model");
  if (!provider || !model) throw new Error("reviewer requires both provider and model");
  const reasoningEffort = (optionalString(reviewer.reasoningEffort, "reviewer.reasoningEffort")
    ?? DEFAULT_REVIEWER_REASONING_EFFORT) as ReasoningEffort;
  if (!REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new Error("reviewer.reasoningEffort is invalid");
  }
  const timeoutMs = boundedInteger(
    reviewer.timeoutMs,
    DEFAULT_REVIEWER_TIMEOUT_MS,
    MIN_REVIEWER_TIMEOUT_MS,
    MAX_REVIEWER_TIMEOUT_MS,
    "reviewer.timeoutMs",
  );
  const prefilter = optionalBoolean(reviewer.prefilter, "reviewer.prefilter");
  return {
    provider,
    model,
    reasoningEffort,
    timeoutMs,
    prefilter: prefilter === true,
  };
}

export function loadAutoPermissionsConfig(path = autoPermissionsConfigPath()): AutoPermissionsConfig {
  const raw = readObject(path);
  optionalBoolean(raw.enabled, "enabled");
  optionalBoolean(raw.reviewAllShell, "reviewAllShell");
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
    evaluationLog: resolveSidecar(raw, "evaluationLog", "review-evals.jsonl", false, path),
    usageLog: resolveSidecar(raw, "usageLog", "usage.jsonl", true, path),
    denialLog: resolveSidecar(raw, "denialLog", "denials.jsonl", true, path),
    standingApprovals: resolveSidecar(raw, "standingApprovals", "standing-approvals.jsonl", true, path),
    rules,
    reviewAllShell: raw.reviewAllShell === true,
    guardianPolicy: resolveGuardianPolicy(raw),
    ui: resolveUi(raw),
  };
}
