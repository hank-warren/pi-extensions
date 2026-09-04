import { homedir } from "node:os";
import {
	type Component,
	Input,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type SettingItem,
	type SettingsListTheme,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { type BooleanSettingKey, collapseHome, resolveWorktreeRoot, type StatuslineSettings } from "./settings.ts";
import type { CustomItemState } from "./custom.ts";
import { CELEBRATION_STYLE_NAMES, isCelebrationStyleName } from "./celebration-styles.ts";
import { isThemeName, THEME_NAMES } from "./themes.ts";

export const THEME_ID = "theme";
export const CACHE_CELEBRATION_ID = "showCacheCelebration";
export const WORKTREE_ROOT_ID = "worktreeRoot";
export const REPO_ALIASES_ID = "repoAliases";
export const CUSTOM_ITEMS_ID = "customItems";
export const ADD_ALIAS_VALUE = "\u0000add";

export const ON = "on";
export const OFF = "off";
const TOGGLE_VALUES = [ON, OFF];

interface BooleanRow {
	id: BooleanSettingKey;
	label: string;
	description: string;
}

/** Toggle rows, in statusline render order. */
export const BOOLEAN_ROWS: readonly BooleanRow[] = [
	{ id: "showModel", label: "Model", description: "Show the active model id." },
	{ id: "showProvider", label: "Provider", description: "Show the provider of the active model." },
	{ id: "showDirectory", label: "Directory & git", description: "Show the working directory and its git branch." },
	{ id: "showContext", label: "Context", description: "Show context tokens used against the window." },
	{ id: "showUsage", label: "Subscription usage", description: "Show Claude/Codex remaining-headroom meters." },
	{ id: "showCustomItems", label: "Custom items", description: "Run your configured commands and show their output." },
	{ id: "showWorktrees", label: "Worktree line", description: "Show touched worktrees and their pull requests." },
	{ id: "showSessionId", label: "Session ID line", description: "Show the full Pi session id on its own line." },
];

/** Label of the celebration row, used to drive the settings-menu preview loop. */
export const CACHE_CELEBRATION_LABEL = "Cache celebration";

/** The celebration row folds "off" into the style list, so it is one row, not two. */
export function celebrationValue(settings: StatuslineSettings): string {
	return settings.showCacheCelebration ? settings.cacheCelebrationStyle : OFF;
}

export function toggleValue(enabled: boolean): string {
	return enabled ? ON : OFF;
}

export function aliasSummary(settings: StatuslineSettings): string {
	const count = Object.keys(settings.repoAliases).length;
	return `${count} alias${count === 1 ? "" : "es"}`;
}

/** Row value for the custom-items submenu: how many items are switched on. */
export function customItemsSummary(settings: StatuslineSettings): string {
	const total = settings.customItems.length;
	if (total === 0) return "none configured";
	return `${settings.customItems.filter((item) => item.enabled).length}/${total} on`;
}

/** One row in the custom-items submenu: what it shows and why. */
export function customItemRows(
	settings: StatuslineSettings,
	states: readonly CustomItemState[] = [],
): SelectItem[] {
	const byId = new Map(states.map((state) => [state.id, state]));
	return settings.customItems.map((item) => {
		const state = byId.get(item.id);
		// Configuration errors outrank run errors: an item that cannot be parsed
		// never ran, so a stale run error from a previous config would mislead.
		const error = item.error ?? state?.error;
		// A broken entry reads as "disabled" unless its reason wins here: it is off
		// *because* it cannot run, and "disabled" would suggest the user chose that.
		const detail = item.error !== undefined
			? item.error
			: !item.enabled
				? "disabled"
				: error !== undefined
				? error
				: state?.running === true && state.value === undefined
					? "running…"
					: state?.value !== undefined && state.value.length > 0
						? state.value
						: state?.value !== undefined
							? "empty output"
							: "no value yet";
		return {
			value: item.id,
			label: `${item.enabled ? toggleValue(true) : toggleValue(false)}  ${item.id}`,
			description: detail,
		};
	});
}

export interface SettingSubmenus {
	worktreeRoot?: SettingItem["submenu"];
	repoAliases?: SettingItem["submenu"];
	customItems?: SettingItem["submenu"];
}

/** Build the `/statusline` rows for a settings snapshot. */
export function buildSettingItems(
	settings: StatuslineSettings,
	submenus: SettingSubmenus = {},
	home: string = homedir(),
): SettingItem[] {
	const items: SettingItem[] = [
		{
			id: THEME_ID,
			label: "Theme",
			description: "Colour palette for every statusline element.",
			currentValue: settings.theme,
			values: [...THEME_NAMES],
		},
	];

	// Rows follow the order their elements render in, so the celebration sits
	// after the usage meters it is appended to on line 1.
	for (const row of BOOLEAN_ROWS) {
		items.push({
			id: row.id,
			label: row.label,
			description: row.description,
			currentValue: toggleValue(settings[row.id]),
			values: TOGGLE_VALUES,
		});
		if (row.id === "showUsage") {
			items.push({
				id: CACHE_CELEBRATION_ID,
				label: CACHE_CELEBRATION_LABEL,
				description: "Badge animation after an exceptional prompt-cache hit; previews in the statusline below.",
				currentValue: celebrationValue(settings),
				values: [OFF, ...CELEBRATION_STYLE_NAMES],
			});
		}
	}

	items.push({
		id: WORKTREE_ROOT_ID,
		label: "Worktree root",
		description: "Directory whose children are tracked as session worktrees.",
		currentValue: collapseHome(settings.worktreeRoot, home),
		...(submenus.worktreeRoot ? { submenu: submenus.worktreeRoot } : {}),
	});
	items.push({
		id: REPO_ALIASES_ID,
		label: "Repo aliases",
		description: "Short display names for repositories on the worktree line.",
		currentValue: aliasSummary(settings),
		...(submenus.repoAliases ? { submenu: submenus.repoAliases } : {}),
	});
	items.push({
		id: CUSTOM_ITEMS_ID,
		label: "Custom item list",
		description: "Enable or disable configured items; edit commands in statusline-settings.json.",
		currentValue: customItemsSummary(settings),
		...(submenus.customItems ? { submenu: submenus.customItems } : {}),
	});

	return items;
}

export type SettingChange =
	| { kind: "settings"; settings: StatuslineSettings }
	| { kind: "error"; message: string }
	| { kind: "ignored" };

/** Map one row's new display value onto the settings object. */
export function applySettingChange(
	settings: StatuslineSettings,
	id: string,
	value: string,
	home: string = homedir(),
): SettingChange {
	if (BOOLEAN_ROWS.some((row) => row.id === id)) {
		if (value !== ON && value !== OFF) return { kind: "error", message: `Unknown value for ${id}: ${value}` };
		return { kind: "settings", settings: { ...settings, [id]: value === ON } };
	}
	if (id === CACHE_CELEBRATION_ID) {
		if (value === OFF) {
			return settings.showCacheCelebration
				? { kind: "settings", settings: { ...settings, showCacheCelebration: false } }
				: { kind: "ignored" };
		}
		if (!isCelebrationStyleName(value)) {
			return { kind: "error", message: `Unknown cache celebration style: ${value}` };
		}
		if (settings.showCacheCelebration && settings.cacheCelebrationStyle === value) return { kind: "ignored" };
		return {
			kind: "settings",
			settings: { ...settings, showCacheCelebration: true, cacheCelebrationStyle: value },
		};
	}
	if (id === THEME_ID) {
		if (!isThemeName(value)) return { kind: "error", message: `Unknown statusline theme: ${value}` };
		if (value === settings.theme) return { kind: "ignored" };
		return { kind: "settings", settings: { ...settings, theme: value } };
	}
	if (id === WORKTREE_ROOT_ID) {
		const resolved = resolveWorktreeRoot(value, home);
		if (!resolved.path) return { kind: "error", message: resolved.error ?? "Invalid worktree root" };
		if (resolved.path === settings.worktreeRoot) return { kind: "ignored" };
		return { kind: "settings", settings: { ...settings, worktreeRoot: resolved.path } };
	}
	// Alias edits are committed by the submenu itself; its done() value is display text.
	return { kind: "ignored" };
}

/** Parse an `repo=alias` (or `repo → alias`) submenu line. */
export function parseAliasEntry(input: string): { repo: string; alias: string } | undefined {
	const [rawRepo, ...rest] = input.split(/=|→/);
	const repo = rawRepo?.trim() ?? "";
	const alias = rest.join("=").trim();
	if (repo.length === 0 || alias.length === 0) return undefined;
	return { repo, alias };
}

export function aliasItems(settings: StatuslineSettings): SelectItem[] {
	const items: SelectItem[] = Object.entries(settings.repoAliases)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([repo, alias]) => ({ value: repo, label: `${repo} → ${alias}`, description: "Enter to edit · d to delete" }));
	items.push({ value: ADD_ALIAS_VALUE, label: "Add alias…", description: "Enter a new repo=alias pair" });
	return items;
}

export interface SubmenuHost {
	/** Read the live settings; the menu edits a single shared snapshot. */
	getSettings(): StatuslineSettings;
	/** Live per-item run state, for the custom-items submenu. */
	customItemStates?(): CustomItemState[];
	/** Commit an edit: persists, applies live, and repaints. */
	commit(settings: StatuslineSettings): void;
	notify(message: string): void;
	requestRender(): void;
	settingsTheme: SettingsListTheme;
	selectTheme: SelectListTheme;
	home?: string;
}

/** Single-line text prompt used by both submenus. */
class PromptComponent implements Component {
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

export function createWorktreeRootSubmenu(host: SubmenuHost): NonNullable<SettingItem["submenu"]> {
	const home = host.home ?? homedir();
	return (currentValue, done) =>
		new PromptComponent(
			"Worktree root directory",
			currentValue,
			host.settingsTheme.hint,
			(value) => {
				const resolved = resolveWorktreeRoot(value, home);
				if (!resolved.path) {
					host.notify(resolved.error ?? "Invalid worktree root");
					done(undefined);
					return;
				}
				host.commit({ ...host.getSettings(), worktreeRoot: resolved.path });
				done(collapseHome(resolved.path, home));
			},
			() => done(undefined),
		);
}

/** Alias list submenu: edit, add, delete, toggle the prefix rule, load the preset. */
class AliasSubmenu implements Component {
	private list: SelectList;
	private prompt: PromptComponent | undefined;

	constructor(
		private readonly host: SubmenuHost,
		private readonly done: (value?: string) => void,
	) {
		this.list = this.buildList();
	}

	private buildList(selectedIndex = 0): SelectList {
		const list = new SelectList(aliasItems(this.host.getSettings()), 10, this.host.selectTheme);
		list.setSelectedIndex(selectedIndex);
		list.onCancel = () => this.done(aliasSummary(this.host.getSettings()));
		list.onSelect = (item) => this.activate(item);
		return list;
	}

	private rebuild(selectedIndex: number): void {
		this.list = this.buildList(selectedIndex);
		this.host.requestRender();
	}

	private activate(item: SelectItem): void {
		const settings = this.host.getSettings();
		const editing = item.value === ADD_ALIAS_VALUE ? "" : `${item.value}=${settings.repoAliases[item.value] ?? ""}`;
		this.prompt = new PromptComponent(
			item.value === ADD_ALIAS_VALUE ? "New alias (repo=alias)" : "Edit alias (repo=alias)",
			editing,
			this.host.settingsTheme.hint,
			(value) => this.submitAlias(item.value, value),
			() => {
				this.prompt = undefined;
				this.host.requestRender();
			},
		);
		this.host.requestRender();
	}

	private submitAlias(originalRepo: string, value: string): void {
		this.prompt = undefined;
		const parsed = parseAliasEntry(value);
		if (!parsed) {
			this.host.notify("Enter an alias as repo=alias");
			this.host.requestRender();
			return;
		}
		const settings = this.host.getSettings();
		const aliases = { ...settings.repoAliases };
		if (originalRepo !== ADD_ALIAS_VALUE && originalRepo !== parsed.repo) delete aliases[originalRepo];
		aliases[parsed.repo] = parsed.alias;
		this.host.commit({ ...settings, repoAliases: aliases });
		this.rebuild(aliasItems(this.host.getSettings()).findIndex((row) => row.value === parsed.repo));
	}

	private deleteSelected(): void {
		const selected = this.list.getSelectedItem();
		if (!selected || selected.value.startsWith("\u0000")) return;
		const settings = this.host.getSettings();
		const aliases = { ...settings.repoAliases };
		delete aliases[selected.value];
		this.host.commit({ ...settings, repoAliases: aliases });
		this.rebuild(0);
	}

	invalidate(): void {
		this.prompt?.invalidate();
		this.list.invalidate();
	}

	render(width: number): string[] {
		if (this.prompt) return this.prompt.render(width);
		return [
			truncateToWidth(this.host.settingsTheme.hint("  Repo aliases"), width),
			"",
			...this.list.render(width),
			"",
			truncateToWidth(this.host.settingsTheme.hint("  Enter to edit · d to delete · Esc to go back"), width),
		];
	}

	handleInput(data: string): void {
		if (this.prompt) {
			this.prompt.handleInput(data);
			return;
		}
		if (data === "d") {
			this.deleteSelected();
			return;
		}
		this.list.handleInput(data);
	}
}

export function createAliasSubmenu(host: SubmenuHost): NonNullable<SettingItem["submenu"]> {
	return (_currentValue, done) => new AliasSubmenu(host, done);
}

/**
 * Custom item list: enable/disable each item and read why it is not showing.
 *
 * Commands are edited in the settings file, not here. A statusline command is a
 * shell line with quoting and pipes in it, which a single-line TUI prompt edits
 * badly, and keeping the field out of the menu means a toggle writes only the
 * `enabled` flag over whatever the file currently holds.
 */
class CustomItemsSubmenu implements Component {
	private list: SelectList;

	constructor(
		private readonly host: SubmenuHost,
		private readonly done: (value?: string) => void,
	) {
		this.list = this.buildList();
	}

	private buildList(selectedIndex = 0): SelectList {
		const rows = customItemRows(this.host.getSettings(), this.host.customItemStates?.() ?? []);
		const list = new SelectList(
			rows.length > 0
				? rows
				: [{ value: "\u0000none", label: "No custom items", description: "Add them to statusline-settings.json" }],
			10,
			this.host.selectTheme,
		);
		list.setSelectedIndex(selectedIndex);
		list.onCancel = () => this.done(customItemsSummary(this.host.getSettings()));
		list.onSelect = (item) => this.toggle(item.value);
		return list;
	}

	private toggle(id: string): void {
		if (id.startsWith("\u0000")) return;
		const settings = this.host.getSettings();
		const index = settings.customItems.findIndex((item) => item.id === id);
		const target = settings.customItems[index];
		if (!target) return;
		if (target.error !== undefined && !target.enabled) {
			// Enabling an unparseable entry would only fail again on the next tick.
			this.host.notify(`${id} cannot run: ${target.error}`);
			return;
		}
		const customItems = [...settings.customItems];
		customItems[index] = { ...target, enabled: !target.enabled };
		this.host.commit({ ...settings, customItems });
		this.list = this.buildList(index);
		this.host.requestRender();
	}

	invalidate(): void {
		this.list.invalidate();
	}

	render(width: number): string[] {
		return [
			truncateToWidth(this.host.settingsTheme.hint("  Custom items"), width),
			"",
			...this.list.render(width),
			"",
			truncateToWidth(this.host.settingsTheme.hint("  Enter to enable/disable · Esc to go back"), width),
		];
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

export function createCustomItemsSubmenu(host: SubmenuHost): NonNullable<SettingItem["submenu"]> {
	return (_currentValue, done) => new CustomItemsSubmenu(host, done);
}
