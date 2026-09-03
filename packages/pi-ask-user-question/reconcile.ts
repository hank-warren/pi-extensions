/**
 * Mid-session lifecycle reconciliation for `ask_user_question`.
 *
 * WHY THIS EXISTS — read before changing it.
 *
 * Subagent children run headless (`ctx.hasUI === false`). They must never be
 * able to block waiting on a human, and they must never route a question up to
 * the supervisor. Stripping the tool from the active set is the mechanism that
 * enforces that: the LLM in a headless run never sees the tool, so it cannot
 * call it, so it cannot stall a background run forever.
 *
 * Do NOT "improve" this into an escalation bridge. See
 * docs/specs/pi-ask-user-question.md §2 and §7 — no-subagent-escalation is an
 * explicit non-goal, not an oversight.
 *
 * Unlike @juicesharp/rpiv-ask-user-question there is no carve-out for
 * `ctx.mode === "rpc"`, because this package ships no RPC dialog fallback:
 * `hasUI` is the only signal and it is honest here.
 *
 * The in-handler `!ctx.hasUI` guard in ask-user-question.ts stays as a
 * one-turn backstop in case a future pi release snapshots the tool list before
 * `before_agent_start` runs.
 */

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ASK_USER_AVAILABILITY_EVENT } from "./events.ts";
import { TOOL_NAME } from "./tool/schema.ts";

/**
 * Strip or restore the tool to match `ctx.hasUI`. Idempotent: when the tool is
 * already in the right state, the active set (and every sibling tool in it) is
 * left untouched.
 */
export function reconcileTool(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	ownSourcePath?: string,
): boolean {
	const active = pi.getActiveTools();
	const present = active.includes(TOOL_NAME);
	let wrote = false;
	if (!ctx.hasUI && present) {
		pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
		wrote = true;
	} else if (ctx.hasUI && !present && ownsRegisteredTool(pi, ownSourcePath)) {
		pi.setActiveTools([...active, TOOL_NAME]);
		wrote = true;
	}
	// Availability is read back from the host, never assumed from the list we
	// asked for: Pi silently ignores a name that is excluded by --tools or a
	// tool policy, so an accepted write is not proof the tool is there. Plan
	// mode drops its own fallback on this signal, and a false positive would
	// leave an interactive session with no question tool at all.
	const available =
		ctx.hasUI && (wrote ? pi.getActiveTools() : active).includes(TOOL_NAME);
	pi.events?.emit(ASK_USER_AVAILABILITY_EVENT, { available });
	return available;
}

/**
 * Whether the name is still backed by *this* package's registration.
 *
 * Compared by directory, not by exact path: Pi records the extension path as
 * it was configured (relative, npm-resolved, or synthetic) while `baseDir` is
 * the resolved directory, and only the directory is stable across all three.
 * Anything unknowable fails open to "ours", which preserves the original
 * always-restore behaviour on hosts that report no source information.
 */
function ownsRegisteredTool(pi: ExtensionAPI, ownSourcePath?: string): boolean {
	if (!ownSourcePath || typeof pi.getAllTools !== "function") return true;
	const effective = pi.getAllTools().find((tool) => tool.name === TOOL_NAME);
	if (!effective) return true;
	const info = effective.sourceInfo as { path?: string; baseDir?: string } | undefined;
	const ownDir = dirname(ownSourcePath);
	if (info?.baseDir) return sameDirectory(info.baseDir, ownDir);
	if (info?.path) return sameDirectory(dirname(info.path), ownDir);
	return true;
}

/**
 * Directory equality that survives a symlink on either side.
 *
 * `resolve()` alone is not enough, and the asymmetry is guaranteed rather than
 * unlucky: `ownSourcePath` comes from `import.meta.url`, which Node hands back
 * already realpath-resolved, while Pi passes `sourceInfo.baseDir` through
 * untouched (`core/source-info.js`). Any workspace, pnpm, or npm-link install
 * reaches the package through a symlink, so the two spellings differ for the
 * same directory — and the caller treats a mismatch as "not ours", which would
 * strip `ask_user_question` on the first headless run and never restore it,
 * leaving an interactive session with no question tool at all.
 *
 * A `realpathSync` throw (a deleted or unreadable path) falls back to the
 * lexical form rather than propagating, matching the fail-open posture of
 * every other branch in `ownsRegisteredTool`.
 */
function sameDirectory(a: string, b: string): boolean {
	const canonical = (path: string): string => {
		const absolute = resolve(path);
		try {
			return realpathSync(absolute);
		} catch {
			return absolute;
		}
	};
	return canonical(a) === canonical(b);
}

export function registerReconciler(pi: ExtensionAPI, ownSourcePath?: string): void {
	pi.on("before_agent_start", (_event, ctx) => {
		reconcileTool(pi, ctx, ownSourcePath);
	});
}
