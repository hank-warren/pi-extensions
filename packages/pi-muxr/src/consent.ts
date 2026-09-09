/**
 * The chat-write consent gates.
 *
 * Chat write is off unless **all three** of these are true, checked in this
 * order and re-read on every request:
 *
 * 1. `muxr.experimentalChatWrite: true` in Pi's settings — the user's opt-in;
 * 2. the `--muxr-experimental-chat-write` CLI flag — consent visible in the
 *    controlled process's own argv, so a bridge can refuse a Pi that was not
 *    started for it without reading a file it cannot see;
 * 3. the bridge asked for the `chatWrite` capability in its `registered`
 *    envelope — the operator side of the same decision.
 *
 * Any one missing means `disabled.chatWrite: true` is advertised on every
 * snapshot and every `chat_write` request is refused. When all three hold, the
 * snapshot advertises `disabled.chatWrite: false`. The decision is re-sampled
 * per snapshot and per request, so revoking the setting is visible on the wire
 * without restarting Pi.
 *
 * ## Why the setting is read from the file rather than from an API
 *
 * Pi 0.85.1 exposes no settings accessor to extensions: `ExtensionContext` has
 * `ui`, `mode`, `hasUI`, `cwd`, `sessionManager`, `modelRegistry`, `model`,
 * `scopedModels`, `thinkingLevel`, `isIdle`, `isProjectTrusted`, `signal`,
 * `abort`, `hasPendingMessages`, `shutdown`, `getContextUsage`, `compact` and
 * `getSystemPrompt` — and nothing for settings. The `Settings` interface is
 * closed, with no index signature and no getter for extension-defined keys.
 * Reading the JSON directly is the only way to honour a user preference
 * expressed as a Pi setting, and it is what `pi-auto-permissions` already does
 * for `shellCommandPrefix`/`shellPath`.
 *
 * **The key survives Pi's own writes.** `SettingsManager.persistScopedSettings`
 * re-reads the settings file under a lock and merges only the fields it
 * explicitly modified onto that object, so an unknown `muxr.*` key is
 * preserved when the user changes anything through `/settings` or Ctrl+S.
 * Verified against the shipped `dist/core/settings-manager.js` in Pi 0.85.1.
 *
 * If a future Pi release did strip unknown keys, this gate would read `false`
 * and chat write would turn **off** — the safe direction.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import { REQUESTABLE_CAPABILITIES } from "./contracts.ts";

/** The settings key the user sets to opt in. */
export const CHAT_WRITE_SETTING = "muxr.experimentalChatWrite";

/** The CLI flag that must also be present. */
export const CHAT_WRITE_FLAG = "muxr-experimental-chat-write";

/**
 * The capability name the bridge must request.
 *
 * Sourced from the wire contract rather than written twice, so the token in
 * `REGISTERED_SHAPE` and the one compared here cannot drift apart.
 */
export const CHAT_WRITE_CAPABILITY = REQUESTABLE_CAPABILITIES[0];

/**
 * Read a settings file, treating every failure as "no settings".
 *
 * Unreadable, absent, malformed, or non-object contents all yield `{}` rather
 * than throwing: a broken settings file must leave chat write off, not crash
 * the session this extension is only observing.
 */
function readSettingsFile(path: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/**
 * Whether the user opted in through Pi's settings.
 *
 * Global settings are read from the agent dir. Project settings override them
 * only when the project is trusted: an untrusted project must not be able to
 * turn on a write capability by shipping a `.pi/settings.json`.
 *
 * Strict `=== true`: any other value, including `"true"` and `1`, is off.
 */
export function readChatWriteSetting({
	cwd,
	projectTrusted,
}: {
	cwd: string;
	projectTrusted: boolean;
}): boolean {
	const global = readSettingsFile(join(getAgentDir(), "settings.json"));
	const project = projectTrusted
		? readSettingsFile(join(cwd, CONFIG_DIR_NAME, "settings.json"))
		: {};
	const value = Object.hasOwn(project, CHAT_WRITE_SETTING)
		? project[CHAT_WRITE_SETTING]
		: global[CHAT_WRITE_SETTING];
	return value === true;
}

/** Which gate refused, for the `chat_write_result` reason and diagnostics. */
export type ConsentGate = "setting" | "flag" | "capability";

export interface ConsentInput {
	cwd: string;
	projectTrusted: boolean;
	flagPresent: boolean;
	bridgeRequested: boolean;
}

export interface ConsentDecision {
	enabled: boolean;
	/** Gates that are not satisfied, in check order. Empty when enabled. */
	missing: ConsentGate[];
}

/**
 * Evaluate all three gates.
 *
 * Every gate is evaluated rather than short-circuiting, so an operator
 * diagnosing "why is chat write off" gets the whole answer at once instead of
 * fixing one gate to discover the next.
 */
export function evaluateChatWriteConsent(input: ConsentInput): ConsentDecision {
	const missing: ConsentGate[] = [];
	if (!readChatWriteSetting({ cwd: input.cwd, projectTrusted: input.projectTrusted })) {
		missing.push("setting");
	}
	if (!input.flagPresent) missing.push("flag");
	if (!input.bridgeRequested) missing.push("capability");
	return { enabled: missing.length === 0, missing };
}

/**
 * The stable machine token reported when a gate refuses a request.
 *
 * `chat_write_disabled` names the fact the client must surface; the specific
 * gate follows so an operator can fix the right one.
 */
export function consentRefusalReason(missing: ConsentGate[]): string {
	return `chat_write_disabled:${missing.join(",")}`;
}
