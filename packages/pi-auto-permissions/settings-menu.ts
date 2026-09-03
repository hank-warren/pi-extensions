/**
 * Row model and pure edit logic behind `/auto-permissions`.
 *
 * Everything that decides *what* a row shows or what an edit means lives here,
 * free of pi's runtime, so it is testable without a TUI. index.ts owns only the
 * wiring: read config, render a SettingsList, persist through config-writer.
 */
import { homedir } from "node:os";
import {
  type Component,
  getKeybindings,
  Input,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  type SettingItem,
  type SettingsListTheme,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  DEFAULT_REVIEWER_REASONING_EFFORT,
  DEFAULT_REVIEWER_TIMEOUT_MS,
  MAX_REVIEWER_TIMEOUT_MS,
  MIN_REVIEWER_TIMEOUT_MS,
  REASONING_EFFORTS,
  type ReasoningEffort,
  type SystemPromptSource,
} from "./config.js";
import type { ReviewerBlock } from "./config-writer.js";
import type { StandingApprovalRecord } from "./standing-overrides.js";

const ENABLED_ID = "enabled";
const REVIEWER_MODEL_ID = "reviewerModel";
const THINKING_LEVEL_ID = "reasoningEffort";
const TIMEOUT_ID = "timeoutMs";
const SYSTEM_PROMPT_ID = "systemPrompt";
export const RECENT_DENIALS_ID = "recentDenials";
export const STANDING_APPROVALS_ID = "standingApprovals";

export const ON = "on";
export const OFF = "off";
const TOGGLE_VALUES = [ON, OFF];

const UNSET_MODEL = "(unset)";
const UNAVAILABLE_SUFFIX = "(configured, unavailable)";
const NO_REVIEWER_MESSAGE = "Select a reviewer model first";

/** The slice of the config the menu edits, plus the read-only prompt source. */
export interface ReviewerSettings {
  enabled: boolean;
  reviewer?: ReviewerBlock;
  systemPromptSource: SystemPromptSource;
}

/** The subset of a pi model the menu needs; keeps tests free of pi-ai types. */
export interface MenuModel {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  thinkingLevelMap?: Partial<Record<ReasoningEffort, string | null>>;
}

export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/** Inverse of {@link modelKey}; the provider itself never contains a slash. */
function parseModelKey(value: string): { provider: string; model: string } | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

function reviewerValue(settings: ReviewerSettings): string {
  return settings.reviewer ? modelKey({ provider: settings.reviewer.provider, id: settings.reviewer.model }) : UNSET_MODEL;
}

export function toggleValue(enabled: boolean): string {
  return enabled ? ON : OFF;
}

function thinkingValue(settings: ReviewerSettings): ReasoningEffort {
  return settings.reviewer?.reasoningEffort ?? DEFAULT_REVIEWER_REASONING_EFFORT;
}

function timeoutValue(settings: ReviewerSettings): number {
  return settings.reviewer?.timeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS;
}

/** `~`-collapse a path so a long prompt path still fits the value column. */
export function collapseHome(path: string, home: string = homedir()): string {
  const base = home || homedir();
  if (!base) return path;
  if (path === base) return "~";
  return path.startsWith(`${base}/`) ? `~/${path.slice(base.length + 1)}` : path;
}

/** Value column for the read-only system-prompt row. */
export function systemPromptValue(source: SystemPromptSource, home: string = homedir()): string {
  if (source.kind === "file") return collapseHome(source.path, home);
  return source.kind === "inline" ? "(inline in config)" : "(built-in default)";
}

function systemPromptDescription(source: SystemPromptSource): string {
  if (source.kind === "file") return "Active reviewer system prompt, from systemPromptFile. Edit the file to change it.";
  if (source.kind === "inline") return "Active reviewer system prompt, from the systemPrompt key in config.json.";
  return "No systemPrompt or systemPromptFile is set, so the packaged reviewer prompt is used.";
}

/** Human-readable timeout: seconds, or `m s` past a minute. */
export function formatTimeout(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  if (seconds < 60) return `${Number(seconds.toFixed(1))}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Number((seconds - minutes * 60).toFixed(1));
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

type TimeoutParse = { timeoutMs: number } | { error: string };

/**
 * Parse a timeout the user typed. A bare number means seconds, because that is
 * what the row displays; `ms` is available when an exact millisecond value
 * matters. The accepted window mirrors the loader's validation exactly.
 */
export function parseTimeoutInput(input: string): TimeoutParse {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(ms|s)?$/i.exec(input.trim());
  if (!match) return { error: "Enter a timeout like 30s or 45000ms" };
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return { error: "Enter a timeout like 30s or 45000ms" };
  const timeoutMs = match[2]?.toLowerCase() === "ms" ? amount : amount * 1000;
  if (!Number.isInteger(timeoutMs)) return { error: "Review timeout must be a whole number of milliseconds" };
  if (timeoutMs < MIN_REVIEWER_TIMEOUT_MS || timeoutMs > MAX_REVIEWER_TIMEOUT_MS) {
    return { error: "Review timeout must be between 1s and 300s" };
  }
  return { timeoutMs };
}

export interface SettingSubmenus {
  reviewerModel?: SettingItem["submenu"];
  timeout?: SettingItem["submenu"];
  recentDenials?: SettingItem["submenu"];
  standingApprovals?: SettingItem["submenu"];
}

/** Build the `/auto-permissions` rows for a settings snapshot. */
export function buildSettingItems(
  settings: ReviewerSettings,
  submenus: SettingSubmenus = {},
  home: string = homedir(),
  denialCount?: number,
  standingApprovalCount?: number,
): SettingItem[] {
  return [
    {
      id: ENABLED_ID,
      label: "Enabled",
      description: "Review guarded commands. Off lets every command run without guardian review.",
      currentValue: toggleValue(settings.enabled),
      values: TOGGLE_VALUES,
    },
    {
      id: REVIEWER_MODEL_ID,
      label: "Reviewer model",
      description: "Model the guardian reviews guarded commands with.",
      currentValue: reviewerValue(settings),
      ...(submenus.reviewerModel ? { submenu: submenus.reviewerModel } : {}),
    },
    {
      id: THINKING_LEVEL_ID,
      label: "Thinking level",
      description: "Reasoning effort requested from the reviewer model.",
      currentValue: thinkingValue(settings),
      values: [...REASONING_EFFORTS],
    },
    {
      id: TIMEOUT_ID,
      label: "Review timeout",
      description: "How long one review may take before the command is denied.",
      currentValue: formatTimeout(timeoutValue(settings)),
      ...(submenus.timeout ? { submenu: submenus.timeout } : {}),
    },
    {
      id: SYSTEM_PROMPT_ID,
      label: "System prompt",
      description: systemPromptDescription(settings.systemPromptSource),
      currentValue: systemPromptValue(settings.systemPromptSource, home),
    },
    ...(submenus.recentDenials
      ? [{
        id: RECENT_DENIALS_ID,
        label: "Recent denials",
        description: "Recently denied or revised commands. Select one to allow it on retry.",
        currentValue: denialCount === undefined ? "" : String(denialCount),
        submenu: submenus.recentDenials,
      }]
      : []),
    ...(submenus.standingApprovals
      ? [{
        id: STANDING_APPROVALS_ID,
        label: "Standing approvals",
        description: "Comparable-command approvals shared across projects. Select one to revoke it.",
        currentValue: standingApprovalCount === undefined ? "" : String(standingApprovalCount),
        submenu: submenus.standingApprovals,
      }]
      : []),
  ];
}

export type SettingChange =
  | { kind: "settings"; settings: ReviewerSettings }
  /** Saved, but the value is worth flagging (e.g. an unsupported thinking level). */
  | { kind: "warn"; settings: ReviewerSettings; message: string }
  | { kind: "error"; message: string }
  | { kind: "ignored" };

/**
 * Map one row's new display value onto the settings snapshot.
 *
 * `model` is the currently configured reviewer model, when the registry knows
 * it; it is only consulted to warn about unsupported thinking levels.
 */
export function applySettingChange(
  settings: ReviewerSettings,
  id: string,
  value: string,
  model?: MenuModel,
): SettingChange {
  if (id === ENABLED_ID) {
    if (value !== ON && value !== OFF) return { kind: "error", message: `Unknown value for ${id}: ${value}` };
    const enabled = value === ON;
    if (enabled === settings.enabled) return { kind: "ignored" };
    return { kind: "settings", settings: { ...settings, enabled } };
  }

  if (id === THINKING_LEVEL_ID) {
    if (!REASONING_EFFORTS.includes(value as ReasoningEffort)) {
      return { kind: "error", message: `Unknown thinking level: ${value}` };
    }
    const reasoningEffort = value as ReasoningEffort;
    // A reviewer block without provider and model is rejected by the loader, so
    // there is nothing valid to write until a model is chosen.
    if (!settings.reviewer) return { kind: "error", message: NO_REVIEWER_MESSAGE };
    if (settings.reviewer.reasoningEffort === reasoningEffort) return { kind: "ignored" };
    const next = { ...settings, reviewer: { ...settings.reviewer, reasoningEffort } };
    if (model?.thinkingLevelMap && model.thinkingLevelMap[reasoningEffort] === null) {
      return {
        kind: "warn",
        settings: next,
        message: `${modelKey(model)} does not support thinking level "${reasoningEffort}"`,
      };
    }
    return { kind: "settings", settings: next };
  }

  // The model and timeout submenus commit their own edit and hand back display
  // text, so there is nothing left to map here.
  return { kind: "ignored" };
}

/** Adopt a picked model, creating the reviewer block when there was none. */
export function applyModelSelection(settings: ReviewerSettings, value: string): SettingChange {
  const parsed = parseModelKey(value);
  if (!parsed) return { kind: "error", message: `Unknown model: ${value}` };
  if (settings.reviewer?.provider === parsed.provider && settings.reviewer.model === parsed.model) {
    return { kind: "ignored" };
  }
  return {
    kind: "settings",
    settings: {
      ...settings,
      reviewer: {
        provider: parsed.provider,
        model: parsed.model,
        reasoningEffort: settings.reviewer?.reasoningEffort ?? DEFAULT_REVIEWER_REASONING_EFFORT,
        timeoutMs: settings.reviewer?.timeoutMs ?? DEFAULT_REVIEWER_TIMEOUT_MS,
      },
    },
  };
}

export function applyTimeoutInput(settings: ReviewerSettings, input: string): SettingChange {
  if (!settings.reviewer) return { kind: "error", message: NO_REVIEWER_MESSAGE };
  const parsed = parseTimeoutInput(input);
  if ("error" in parsed) return { kind: "error", message: parsed.error };
  if (parsed.timeoutMs === settings.reviewer.timeoutMs) return { kind: "ignored" };
  return { kind: "settings", settings: { ...settings, reviewer: { ...settings.reviewer, timeoutMs: parsed.timeoutMs } } };
}

function modelItem(model: MenuModel, unavailable = false): SelectItem {
  const key = modelKey(model);
  const details = [model.name, model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k ctx` : undefined]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return {
    value: key,
    label: unavailable ? `${key}  ${UNAVAILABLE_SUFFIX}` : key,
    description: unavailable ? `${details ? `${details} · ` : ""}provider not signed in or not registered` : details,
  };
}

/**
 * Available models, provider then id, with a configured-but-unavailable
 * reviewer pinned first so opening the menu can never silently drop it.
 */
export function buildModelItems(available: readonly MenuModel[], settings: ReviewerSettings): SelectItem[] {
  const sorted = [...available].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  const items = sorted.map((model) => modelItem(model));
  const reviewer = settings.reviewer;
  if (reviewer && !sorted.some((model) => model.provider === reviewer.provider && model.id === reviewer.model)) {
    items.unshift(modelItem({ provider: reviewer.provider, id: reviewer.model }, true));
  }
  return items;
}

/**
 * Substring filter over the picker rows.
 *
 * `SelectList.setFilter` is a prefix match on `value` alone, which for
 * `provider/model-id` rows means typing "gpt" matches nothing. Filtering here
 * instead keeps "gpt", "luna" and "codex" all useful.
 */
export function filterModelItems(items: readonly SelectItem[], query: string): SelectItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(needle));
}

export interface SubmenuHost {
  /** Read the live settings; the menu edits a single shared snapshot. */
  getSettings(): ReviewerSettings;
  /** Commit an edit: validates, persists, and repaints. */
  commit(change: SettingChange): void;
  availableModels(): MenuModel[];
  requestRender(): void;
  settingsTheme: SettingsListTheme;
  selectTheme: SelectListTheme;
  home?: string;
}

/** Single-line text prompt, mirroring the one behind `/statusline`'s path rows. */
export class PromptComponent implements Component {
  private readonly input = new Input();

  constructor(
    private readonly title: string,
    initialValue: string,
    private readonly hint: (text: string) => string,
    onSubmit: (value: string) => void,
    onCancel: () => void,
  ) {
    this.input.setValue(initialValue);
    this.input.focused = true;
    this.input.onSubmit = onSubmit;
    this.input.onEscape = onCancel;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    return [
      truncateToWidth(this.hint(`  ${this.title}`), width),
      "",
      ...this.input.render(width),
      "",
      truncateToWidth(this.hint("  Enter to save · Esc to cancel"), width),
    ];
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }
}

const LIST_KEYS = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;

/** Searchable reviewer-model picker. */
class ModelSubmenu implements Component {
  private readonly items: SelectItem[];
  private list: SelectList;
  private readonly search = new Input();
  private query = "";

  constructor(
    private readonly host: SubmenuHost,
    private readonly done: (value?: string) => void,
  ) {
    const settings = host.getSettings();
    this.items = buildModelItems(host.availableModels(), settings);
    this.list = this.buildList(this.items, this.items.findIndex((item) => item.value === reviewerValue(settings)));
    this.search.focused = true;
  }

  private buildList(items: SelectItem[], selectedIndex: number): SelectList {
    const list = new SelectList(items, 10, this.host.selectTheme);
    if (selectedIndex > 0) list.setSelectedIndex(selectedIndex);
    list.onCancel = () => this.done(undefined);
    list.onSelect = (item) => {
      const change = applyModelSelection(this.host.getSettings(), item.value);
      this.host.commit(change);
      this.done(change.kind === "error" ? undefined : item.value);
    };
    return list;
  }

  invalidate(): void {
    this.search.invalidate();
    this.list.invalidate();
  }

  render(width: number): string[] {
    return [
      truncateToWidth(this.host.settingsTheme.hint("  Reviewer model"), width),
      "",
      ...this.search.render(width),
      "",
      ...this.list.render(width),
      "",
      truncateToWidth(this.host.settingsTheme.hint("  Type to filter · Enter to select · Esc to go back"), width),
    ];
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    // Navigation, Enter and Esc belong to the list; everything else is filter text.
    if (LIST_KEYS.some((key) => kb.matches(data, key))) {
      this.list.handleInput(data);
      return;
    }
    this.search.handleInput(data);
    const query = this.search.getValue();
    if (query === this.query) return;
    this.query = query;
    this.list = this.buildList(filterModelItems(this.items, query), 0);
    this.host.requestRender();
  }
}

export function createModelSubmenu(host: SubmenuHost): NonNullable<SettingItem["submenu"]> {
  return (_currentValue, done) => new ModelSubmenu(host, done);
}

/** A denial the menu can display and allow on retry; index maps log records here. */
export interface DenialSummary {
  id: string;
  ts: string;
  gateLabel: string;
  command: string;
  verdict: string;
  reason: string;
}

export interface DenialsSubmenuHost {
  recentDenials(): DenialSummary[];
  /** Add the exact-command allow override and nudge the agent to retry. */
  allowRetry(denial: DenialSummary): void;
  settingsTheme: SettingsListTheme;
  selectTheme: SelectListTheme;
  requestRender(): void;
}

const COMMAND_LABEL_MAX = 70;

export function denialItem(denial: DenialSummary): SelectItem {
  const command = denial.command.length > COMMAND_LABEL_MAX
    ? `${denial.command.slice(0, COMMAND_LABEL_MAX - 1)}…`
    : denial.command;
  return {
    value: denial.id,
    label: command,
    description: `${denial.gateLabel} · ${denial.verdict} · ${denial.reason}`,
  };
}

/**
 * Two-stage picker: choose a recent denial, then confirm "Allow on retry".
 * The allow path reuses the existing override machinery — an exact-command
 * session override plus an agent nudge — no new authorization pathway.
 */
class DenialsSubmenu implements Component {
  private readonly denials: DenialSummary[];
  private list: SelectList;
  private selected?: DenialSummary;

  constructor(
    private readonly host: DenialsSubmenuHost,
    private readonly done: (value?: string) => void,
  ) {
    this.denials = host.recentDenials();
    this.list = this.buildDenialList();
  }

  private buildDenialList(): SelectList {
    const items = this.denials.length
      ? this.denials.map(denialItem)
      : [{ value: "", label: "(no denials recorded)", description: "Non-approved commands will appear here." }];
    const list = new SelectList(items, 10, this.host.selectTheme);
    list.onCancel = () => this.done(undefined);
    list.onSelect = (item) => {
      const denial = this.denials.find((candidate) => candidate.id === item.value);
      if (!denial) {
        this.done(undefined);
        return;
      }
      this.selected = denial;
      this.list = this.buildConfirmList();
      this.host.requestRender();
    };
    return list;
  }

  private buildConfirmList(): SelectList {
    const list = new SelectList(
      [
        {
          value: "allow",
          label: "Allow on retry",
          description: "Adds a session override for exactly this command and tells the agent it may retry.",
        },
        { value: "back", label: "Back" },
      ],
      10,
      this.host.selectTheme,
    );
    const back = () => {
      this.selected = undefined;
      this.list = this.buildDenialList();
      this.host.requestRender();
    };
    list.onCancel = back;
    list.onSelect = (item) => {
      if (item.value !== "allow" || !this.selected) {
        back();
        return;
      }
      this.host.allowRetry(this.selected);
      this.done(undefined);
    };
    return list;
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const title = this.selected
      ? `  Allow on retry?  ${truncateToWidth(this.selected.command, Math.max(1, width - 20))}`
      : "  Recent denials";
    return [
      truncateToWidth(this.host.settingsTheme.hint(title), width),
      "",
      ...this.list.render(width),
      "",
      truncateToWidth(this.host.settingsTheme.hint("  Enter to select · Esc to go back"), width),
    ];
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}

export function createDenialsSubmenu(host: DenialsSubmenuHost): NonNullable<SettingItem["submenu"]> {
  return (_currentValue, done) => new DenialsSubmenu(host, done);
}

export interface StandingApprovalSummary {
  id: string;
  record: StandingApprovalRecord;
}

export interface StandingApprovalsSubmenuHost {
  standingApprovals(): StandingApprovalSummary[];
  revokeStandingApproval(approval: StandingApprovalSummary): void;
  settingsTheme: SettingsListTheme;
  selectTheme: SelectListTheme;
  requestRender(): void;
}

export function standingApprovalItem(approval: StandingApprovalSummary): SelectItem {
  const command = approval.record.command.length > COMMAND_LABEL_MAX
    ? `${approval.record.command.slice(0, COMMAND_LABEL_MAX - 1)}…`
    : approval.record.command;
  return {
    value: approval.id,
    label: command,
    description: `${approval.record.gate.label} · granted ${approval.record.ts.slice(0, 10)} · ${approval.record.project}`,
  };
}

class StandingApprovalsSubmenu implements Component {
  private readonly approvals: StandingApprovalSummary[];
  private list: SelectList;
  private selected?: StandingApprovalSummary;

  constructor(
    private readonly host: StandingApprovalsSubmenuHost,
    private readonly done: (value?: string) => void,
  ) {
    this.approvals = host.standingApprovals();
    this.list = this.buildApprovalList();
  }

  private buildApprovalList(): SelectList {
    const items = this.approvals.length
      ? this.approvals.map(standingApprovalItem)
      : [{ value: "", label: "(no standing approvals)", description: "Comparable-command approvals will appear here." }];
    const list = new SelectList(items, 10, this.host.selectTheme);
    list.onCancel = () => this.done(undefined);
    list.onSelect = (item) => {
      const approval = this.approvals.find((candidate) => candidate.id === item.value);
      if (!approval) {
        this.done(undefined);
        return;
      }
      this.selected = approval;
      this.list = this.buildConfirmList();
      this.host.requestRender();
    };
    return list;
  }

  private buildConfirmList(): SelectList {
    const list = new SelectList(
      [
        {
          value: "revoke",
          label: "Revoke",
          description: "Removes this approval from the user-scoped standing ledger.",
        },
        { value: "back", label: "Back" },
      ],
      10,
      this.host.selectTheme,
    );
    const back = () => {
      this.selected = undefined;
      this.list = this.buildApprovalList();
      this.host.requestRender();
    };
    list.onCancel = back;
    list.onSelect = (item) => {
      if (item.value !== "revoke" || !this.selected) {
        back();
        return;
      }
      this.host.revokeStandingApproval(this.selected);
      this.done(undefined);
    };
    return list;
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const title = this.selected
      ? `  Revoke standing approval?  ${truncateToWidth(this.selected.record.command, Math.max(1, width - 30))}`
      : "  Standing approvals";
    return [
      truncateToWidth(this.host.settingsTheme.hint(title), width),
      "",
      ...this.list.render(width),
      "",
      truncateToWidth(this.host.settingsTheme.hint("  Enter to select · Esc to go back"), width),
    ];
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}

export function createStandingApprovalsSubmenu(
  host: StandingApprovalsSubmenuHost,
): NonNullable<SettingItem["submenu"]> {
  return (_currentValue, done) => new StandingApprovalsSubmenu(host, done);
}

export function createTimeoutSubmenu(host: SubmenuHost): NonNullable<SettingItem["submenu"]> {
  return (currentValue, done) =>
    new PromptComponent(
      "Review timeout (e.g. 30s or 45000ms)",
      currentValue,
      host.settingsTheme.hint,
      (value) => {
        const change = applyTimeoutInput(host.getSettings(), value);
        host.commit(change);
        if (change.kind === "error") {
          done(undefined);
          return;
        }
        done(formatTimeout(timeoutValue(host.getSettings())));
      },
      () => done(undefined),
    );
}
