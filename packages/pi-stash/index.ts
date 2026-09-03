/**
 * pi-stash — park an unsent prompt with Alt+S, get it back with Alt+S.
 *
 * The key is configurable (see `config.ts`) because collisions depend on which
 * built-ins and extensions a given host loads, not on this package.
 *
 * Two modes on one key, chosen by whether the editor holds anything:
 *
 * - Editor has substantive text: stash it and clear the editor, so the empty
 *   editor is free for `/model`, a quick `/`-command, or a shell escape.
 * - Editor is empty (or whitespace only): open a selector of the stashes,
 *   newest first, and restore the chosen one.
 *
 * Stashes live in this extension instance's memory and nowhere else. They
 * survive a model change, and are deliberately discarded by `/reload`, session
 * replacement, or process exit — an unsent prompt never reaches session JSONL,
 * settings, or any other file.
 *
 * Two API choices carry the paste behaviour and are not interchangeable:
 *
 * - `getEditorText()` returns the *expanded* body of a `[paste #N …]` marker,
 *   so the stash holds the real payload rather than the placeholder.
 * - `pasteToEditor()` on restore routes back through Pi's paste handling, so a
 *   large body collapses to a compact marker again instead of flooding the
 *   editor. `setEditorText()` would paste it verbatim.
 *
 * Restoration never submits: no Enter is synthesized and `sendUserMessage` is
 * never called, so the prompt comes back editable and unsent.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { SHORTCUT_OFF, formatShortcut, loadStashConfig } from "./config.ts";

/** One parked prompt. `id` is unique and increasing for the extension runtime. */
interface Stash {
	id: number;
	text: string;
}

/** Upper bound on the single-line preview rendered in the selector. */
const PREVIEW_LIMIT = 60;

/** Collapse any run of whitespace so a multiline body previews on one line. */
function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * A short, single-line description of a stash, derived from its first nonblank
 * line. Never renders the whole prompt: a stash is typically parked precisely
 * because it is long.
 */
function previewOf(text: string): string {
	const firstNonBlank = text.split("\n").find((line) => line.trim().length > 0) ?? "";
	const collapsed = collapseWhitespace(firstNonBlank);
	if (collapsed.length === 0) return "(blank)";
	if (collapsed.length <= PREVIEW_LIMIT) return collapsed;
	return `${collapsed.slice(0, PREVIEW_LIMIT - 1)}…`;
}

/**
 * Plural-aware unit, so a count of one does not read as "1 lines". `plural` is
 * explicit because the one word this extension says most often is "stash",
 * whose plural is not formed by appending "s".
 */
function count(value: number, unit: string, plural = `${unit}s`): string {
	return `${value} ${value === 1 ? unit : plural}`;
}

/**
 * Selector label for one stash. The `#<id>` prefix is what makes every option
 * unique — two identical prompts must still be individually selectable.
 */
function formatStashOption(stash: Stash): string {
	const lines = stash.text.split("\n").length;
	return `#${stash.id}  ${previewOf(stash.text)}  (${count(lines, "line")}, ${count(
		stash.text.length,
		"char",
	)})`;
}

export default function stashExtension(pi: ExtensionAPI): void {
	const stashes: Stash[] = [];
	let nextId = 1;
	const { shortcut, problem } = loadStashConfig();
	const keyLabel = formatShortcut(shortcut);
	let pendingProblem = problem;

	/**
	 * Every notification goes through here so a config complaint can ride along
	 * with the first one. Notifying separately does not work: Pi shows the latest
	 * notification, so the action's own message lands immediately afterwards and
	 * the warning is never seen. Reported once, then dropped — a bad file must not
	 * nag on every keypress.
	 */
	function notify(ctx: ExtensionContext, message: string): void {
		if (pendingProblem === undefined) {
			ctx.ui.notify(message);
			return;
		}
		const warning = `pi-stash: ignoring invalid config (${pendingProblem}) — using ${keyLabel}.`;
		pendingProblem = undefined;
		ctx.ui.notify(`${warning} ${message}`);
	}

	async function restore(ctx: ExtensionContext): Promise<void> {
		if (stashes.length === 0) {
			notify(ctx, `No stashed prompts. Press ${keyLabel} with text in the editor to stash it.`);
			return;
		}
		// Newest first: the thing just parked is nearly always the thing wanted.
		const ordered = [...stashes].reverse();
		const options = ordered.map(formatStashOption);
		const choice = await ctx.ui.select("Restore stashed prompt", options);
		// Cancelled (Esc): every stash stays exactly where it was.
		if (choice === undefined) return;
		const index = options.indexOf(choice);
		if (index === -1) return;
		const stash = ordered[index];
		// Paste, not set: keeps Pi's large-content collapsing and does not submit.
		ctx.ui.pasteToEditor(stash.text);
		// Consume only after the restore succeeded, and only this one.
		const position = stashes.indexOf(stash);
		if (position !== -1) stashes.splice(position, 1);
		notify(ctx, `Restored stash #${stash.id}. ${count(stashes.length, "stash", "stashes")} left.`);
	}

	// `off` leaves the key to whoever else wants it and registers nothing.
	if (shortcut === SHORTCUT_OFF) return;

	pi.registerShortcut(shortcut as KeyId, {
		description: "Stash the current prompt, or restore one when the editor is empty",
		handler: async (ctx) => {
			// Reading here expands any [paste #N …] marker to its real body.
			const text = ctx.ui.getEditorText();
			if (text.trim().length === 0) {
				await restore(ctx);
				return;
			}
			const stash: Stash = { id: nextId++, text };
			stashes.push(stash);
			ctx.ui.setEditorText("");
			notify(ctx, `Stashed prompt #${stash.id}. ${count(stashes.length, "stash", "stashes")} held.`);
		},
	});
}
