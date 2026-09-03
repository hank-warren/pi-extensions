/**
 * Shortcut configuration for pi-stash.
 *
 * The key is configurable because a shortcut collision is a property of the
 * *host*, not of this package: Pi's built-in keybindings, every other loaded
 * extension, and the user's own `keybindings.json` all compete for the same
 * small space, and no default can be right everywhere. Without this, dodging a
 * collision means waiting for a release.
 *
 * Config lives at `<agent dir>/pi-stash.json`:
 *
 *     { "shortcut": "ctrl+shift+p" }   // any Pi key id
 *     { "shortcut": "off" }            // register nothing at all
 *
 * Loading never throws. A malformed file falls back to the default and reports
 * the reason through `problem`, because an unreadable preference is a far
 * smaller failure than an extension that will not load.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const CONFIG_FILENAME = "pi-stash.json";

/**
 * Chosen to be free of Pi's built-in keybindings, and to survive terminals
 * without the kitty keyboard protocol — `alt+s` arrives as ESC+s, where
 * `ctrl+shift+<letter>` is silently indistinguishable from `ctrl+<letter>`.
 */
export const DEFAULT_SHORTCUT = "alt+s";

/** Sentinel that disables the shortcut entirely, leaving the key to its owner. */
export const SHORTCUT_OFF = "off";

interface StashConfig {
	/** Resolved key id, or `SHORTCUT_OFF` when the shortcut is disabled. */
	shortcut: string;
	/** Why the file was ignored, when it was. Absent on a clean load. */
	problem?: string;
}

function stashConfigPath(): string {
	return process.env.PI_STASH_CONFIG
		? resolve(process.env.PI_STASH_CONFIG)
		: join(getAgentDir(), CONFIG_FILENAME);
}

/**
 * Strict parse: unknown fields are an error rather than a silent typo, which is
 * the whole point of a config that exists to fix a broken key.
 */
export function parseStashConfig(value: unknown): StashConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("pi-stash config must be an object");
	}
	const input = value as Record<string, unknown>;
	const unknown = Object.keys(input).filter((key) => key !== "shortcut");
	if (unknown.length > 0) {
		throw new Error(
			`pi-stash config contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
		);
	}
	if (input.shortcut === undefined) return { shortcut: DEFAULT_SHORTCUT };
	if (typeof input.shortcut !== "string" || !input.shortcut.trim()) {
		throw new Error("shortcut must be a non-empty string");
	}
	return { shortcut: input.shortcut.trim().toLowerCase() };
}

export function loadStashConfig(path = stashConfigPath()): StashConfig {
	if (!existsSync(path)) return { shortcut: DEFAULT_SHORTCUT };
	try {
		return parseStashConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { shortcut: DEFAULT_SHORTCUT, problem: `${path}: ${message}` };
	}
}

/** `alt+s` -> `Alt+S`, so prompts name the key the way a footer would. */
export function formatShortcut(key: string): string {
	return key
		.split("+")
		.map((part) => (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
		.join("+");
}
