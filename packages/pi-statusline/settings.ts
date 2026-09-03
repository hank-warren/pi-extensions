import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pid } from "node:process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type CelebrationStyleName,
	DEFAULT_CELEBRATION_STYLE,
	isCelebrationStyleName,
} from "./celebration-styles.ts";
import { DEFAULT_THEME, isThemeName, type StatuslineThemeName } from "./themes.ts";

/** Toggle keys, in the order the `/statusline` menu lists them. */
export const BOOLEAN_SETTING_KEYS = [
	"showModel",
	"showProvider",
	"showDirectory",
	"showContext",
	"showUsage",
	"showWorktrees",
	"showSessionId",
	"showCacheCelebration",
] as const;

export type BooleanSettingKey = (typeof BOOLEAN_SETTING_KEYS)[number];

export interface StatuslineSettings extends Record<BooleanSettingKey, boolean> {
	/** Colour palette name; see themes.ts. */
	theme: StatuslineThemeName;
	/** Cache-hit badge animation; only consulted when showCacheCelebration is on. */
	cacheCelebrationStyle: CelebrationStyleName;
	/** Directory whose immediate children are treated as session worktrees. */
	worktreeRoot: string;
	/** `repository name -> display alias` overrides for the worktree line. */
	repoAliases: Record<string, string>;
}

function defaultWorktreeRoot(home: string = homedir()): string {
	return join(home || homedir(), "repos", "worktrees");
}

export function defaultSettings(home: string = homedir()): StatuslineSettings {
	return {
		showModel: true,
		// Opt-in: the provider is redundant for anyone with a single login per family.
		showProvider: false,
		showDirectory: true,
		showContext: true,
		showUsage: true,
		showWorktrees: true,
		showSessionId: true,
		showCacheCelebration: true,
		theme: DEFAULT_THEME,
		cacheCelebrationStyle: DEFAULT_CELEBRATION_STYLE,
		worktreeRoot: defaultWorktreeRoot(home),
		repoAliases: {},
	};
}

/**
 * Where the settings live when the caller names no path.
 *
 * The agent dir, not the home dir: pi honours `PI_CODING_AGENT_DIR`, so a
 * session running against a scratch agent dir must save its statusline settings
 * there rather than into the host's real `~/.pi/agent`. `home` still shapes the
 * settings' *content* (the worktree root default, `~` collapsing) — that is a
 * different thing and keeps its own parameter.
 */
export function defaultSettingsPath(): string {
	return join(getAgentDir(), "statusline-settings.json");
}

/** Expand a leading `~` (and `$HOME`) against `home`; other paths are returned as-is. */
export function expandHome(path: string, home: string = homedir()): string {
	const trimmed = path.trim();
	const base = home || homedir();
	if (trimmed === "~" || trimmed === "$HOME") return base;
	if (trimmed.startsWith("~/")) return join(base, trimmed.slice(2));
	if (trimmed.startsWith("$HOME/")) return join(base, trimmed.slice("$HOME/".length));
	return trimmed;
}

/** Inverse of {@link expandHome}, for compact display in the menu. */
export function collapseHome(path: string, home: string = homedir()): string {
	const base = home || homedir();
	if (!base) return path;
	if (path === base) return "~";
	return path.startsWith(`${base}/`) ? `~/${path.slice(base.length + 1)}` : path;
}

interface WorktreeRootResult {
	path?: string;
	error?: string;
}

/** Validate a user-entered worktree root: `~`-expanded, and absolute afterwards. */
export function resolveWorktreeRoot(input: string, home: string = homedir()): WorktreeRootResult {
	const expanded = expandHome(input, home);
	if (expanded.length === 0) return { error: "Worktree root cannot be empty" };
	if (!isAbsolute(expanded)) return { error: `Worktree root must be an absolute path: ${input.trim()}` };
	return { path: expanded.replace(/\/+$/, "") || "/" };
}

/** Resolve a repository's display alias; with an empty map this is the identity. */
export function repoAlias(repo: string, aliases: Record<string, string> = {}): string {
	return aliases[repo] ?? repo;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAliases(value: unknown): Record<string, string> | undefined {
	if (!isPlainObject(value)) return undefined;
	const aliases: Record<string, string> = {};
	for (const [repo, alias] of Object.entries(value)) {
		if (repo.length > 0 && typeof alias === "string" && alias.length > 0) aliases[repo] = alias;
	}
	return aliases;
}

interface NormalizedSettings {
	settings: StatuslineSettings;
	/** Top-level keys this version does not know about, preserved on write. */
	extra: Record<string, unknown>;
}

/**
 * Best-effort normalization: every key falls back to its own default without
 * discarding valid siblings, and unknown keys are carried through untouched.
 */
export function normalizeSettings(value: unknown, home: string = homedir()): NormalizedSettings {
	const settings = defaultSettings(home);
	const extra: Record<string, unknown> = {};
	if (!isPlainObject(value)) return { settings, extra };

	const known = new Set<string>([
		...BOOLEAN_SETTING_KEYS,
		"theme",
		"cacheCelebrationStyle",
		"worktreeRoot",
		"repoAliases",
	]);
	for (const [key, raw] of Object.entries(value)) {
		if (!known.has(key)) {
			extra[key] = raw;
			continue;
		}
		if (key === "worktreeRoot") {
			if (typeof raw === "string") {
				const resolved = resolveWorktreeRoot(raw, home);
				if (resolved.path) settings.worktreeRoot = resolved.path;
			}
			continue;
		}
		if (key === "repoAliases") {
			const aliases = normalizeAliases(raw);
			if (aliases) settings.repoAliases = aliases;
			continue;
		}
		if (key === "theme") {
			if (isThemeName(raw)) settings.theme = raw;
			continue;
		}
		if (key === "cacheCelebrationStyle") {
			if (isCelebrationStyleName(raw)) settings.cacheCelebrationStyle = raw;
			continue;
		}
		if (typeof raw === "boolean") settings[key as BooleanSettingKey] = raw;
	}

	return { settings, extra };
}

function sameAliases(a: Record<string, string>, b: Record<string, string>): boolean {
	const aKeys = Object.keys(a);
	if (aKeys.length !== Object.keys(b).length) return false;
	return aKeys.every((key) => a[key] === b[key]);
}

/** Every persisted top-level key, so a diff can enumerate them exhaustively. */
export const SETTING_KEYS = [
	...BOOLEAN_SETTING_KEYS,
	"theme",
	"cacheCelebrationStyle",
	"worktreeRoot",
	"repoAliases",
] as const satisfies readonly (keyof StatuslineSettings)[];

export type SettingKey = (typeof SETTING_KEYS)[number];

/**
 * Compile-time completeness guard.
 *
 * `satisfies readonly (keyof StatuslineSettings)[]` above only proves the listed
 * keys are real; it does not prove every key is listed. That gap is silent and
 * expensive: SETTING_KEYS feeds changedSettingKeys, which feeds every save, so a
 * setting missing from it works all session and then vanishes on restart.
 */
type Unlisted<Key extends never> = Key;
type _EverySettingKeyIsListed = Unlisted<Exclude<keyof StatuslineSettings, SettingKey>>;

/** The keys one edit actually touched; the unit of a merging save. */
export function changedSettingKeys(
	previous: StatuslineSettings,
	next: StatuslineSettings,
): SettingKey[] {
	return SETTING_KEYS.filter((key) =>
		key === "repoAliases"
			? !sameAliases(previous.repoAliases, next.repoAliases)
			: previous[key] !== next[key],
	);
}

/**
 * Sparse serialization: only values differing from the defaults are written, so
 * a later default change still reaches hosts that never touched that key.
 */
export function serializeSettings(
	settings: StatuslineSettings,
	extra: Record<string, unknown> = {},
	home: string = homedir(),
): Record<string, unknown> {
	const defaults = defaultSettings(home);
	const out: Record<string, unknown> = { ...extra };
	for (const key of BOOLEAN_SETTING_KEYS) {
		if (settings[key] !== defaults[key]) out[key] = settings[key];
	}
	if (settings.theme !== defaults.theme) out.theme = settings.theme;
	if (settings.cacheCelebrationStyle !== defaults.cacheCelebrationStyle) {
		out.cacheCelebrationStyle = settings.cacheCelebrationStyle;
	}
	if (settings.worktreeRoot !== defaults.worktreeRoot) out.worktreeRoot = settings.worktreeRoot;
	if (!sameAliases(settings.repoAliases, defaults.repoAliases)) out.repoAliases = { ...settings.repoAliases };
	return out;
}

interface SettingsStoreOptions {
	path?: string;
	home?: string;
}

/**
 * Owns the single global settings file. Extensions get no settings API, so this
 * mirrors what usage.ts already does for its shared cache.
 */
export class SettingsStore {
	private readonly home: string;
	private readonly path: string;
	private extra: Record<string, unknown> = {};
	private current: StatuslineSettings;

	constructor(options: SettingsStoreOptions = {}) {
		this.home = options.home ?? homedir();
		this.path = options.path ?? defaultSettingsPath();
		this.current = defaultSettings(this.home);
	}

	getPath(): string {
		return this.path;
	}

	get(): StatuslineSettings {
		return this.current;
	}

	set(settings: StatuslineSettings): void {
		this.current = settings;
	}

	/** Never throws: a missing, unreadable, or malformed file yields defaults. */
	async load(): Promise<StatuslineSettings> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(this.path, "utf8"));
		} catch {
			parsed = undefined;
		}
		const { settings, extra } = normalizeSettings(parsed, this.home);
		this.extra = extra;
		this.current = settings;
		return settings;
	}

	/** Re-read the file as a plain object; anything unusable reads as empty. */
	private async readRaw(): Promise<Record<string, unknown>> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
			return { ...(parsed as Record<string, unknown>) };
		} catch {
			return {};
		}
	}

	/**
	 * Atomic write via temp file + rename. Rejects so the caller can notify.
	 *
	 * With `changed`, only those keys are written over whatever is on disk right
	 * now. Settings load once per session, so a full-snapshot write would let a
	 * session started before an edit silently revert it — including edits made by
	 * hand or by another session. Passing the keys one change actually touched
	 * keeps a writer from claiming fields it was never asked about.
	 */
	async save(settings: StatuslineSettings = this.current, changed?: readonly SettingKey[]): Promise<void> {
		this.current = settings;
		const object = changed ? await this.merge(settings, changed) : serializeSettings(settings, this.extra, this.home);
		const payload = `${JSON.stringify(object, null, "\t")}\n`;
		const temporary = `${this.path}.${pid}.tmp`;
		await mkdir(dirname(this.path), { recursive: true });
		try {
			await writeFile(temporary, payload, { mode: 0o600 });
			await rename(temporary, this.path);
		} catch (error) {
			await unlink(temporary).catch(() => {});
			throw error;
		}
	}

	private async merge(
		settings: StatuslineSettings,
		changed: readonly SettingKey[],
	): Promise<Record<string, unknown>> {
		const merged = await this.readRaw();
		// Serialization is sparse, so a key absent here is back at its default and
		// must be removed rather than written.
		const desired = serializeSettings(settings, {}, this.home);
		for (const key of changed) {
			if (Object.hasOwn(desired, key)) merged[key] = desired[key];
			else delete merged[key];
		}
		return merged;
	}
}
