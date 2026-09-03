/**
 * Shared key handling and comment-mode state for Hank's selector UIs.
 *
 * PUBLIC EXPORT SURFACE — treat as a frozen contract.
 *
 * This module is consumed by sibling packages through the *published* npm
 * package (`@hank-warren/pi-permission-selector`), never by relative source
 * import — see `AGENTS.md` §Conventions. Renaming or removing an export here
 * breaks those consumers at runtime with `MODULE_NOT_FOUND` or an undefined
 * import, which no typecheck in this workspace would catch for a packed
 * tarball. `test/shared-surface-contract.test.ts` pins the surface.
 *
 * Everything here is pure: no pi imports beyond pi-tui's key decoders, no
 * component state, no I/O. The composable `selector.ts` component builds on
 * these primitives (as did the retired `selector-patch.ts` monkey patch).
 */

import { decodeKittyPrintable, Key, matchesKey } from "@earendil-works/pi-tui";

/** Inline cursor drawn at the end of in-progress comment text. */
export const COMMENT_CURSOR = "▌";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// Key predicates via pi-tui's matchesKey so legacy, Kitty keyboard protocol
// (CSI-u, e.g. Esc = \x1b[27u), and modifyOtherKeys encodings all work.
export const isTabKey = (keyData: string): boolean => keyData === "\t" || matchesKey(keyData, "tab");
export const isEscapeKey = (keyData: string): boolean => keyData === "\x1b" || matchesKey(keyData, "escape");
export const isEnterKey = (keyData: string): boolean =>
	keyData === "\r" || keyData === "\n" || matchesKey(keyData, "enter");
export const isBackspaceKey = (keyData: string): boolean =>
	keyData === "\x7f" || keyData === "\b" || matchesKey(keyData, "backspace");
export const isUpKey = (keyData: string): boolean => keyData === "\x1b[A" || matchesKey(keyData, "up");
export const isDownKey = (keyData: string): boolean => keyData === "\x1b[B" || matchesKey(keyData, "down");
export const isLeftKey = (keyData: string): boolean => keyData === "\x1b[D" || matchesKey(keyData, "left");
export const isRightKey = (keyData: string): boolean => keyData === "\x1b[C" || matchesKey(keyData, "right");
/** Shift+Tab, in both the legacy CSI Z and Kitty CSI-u encodings. */
export const isShiftTabKey = (keyData: string): boolean =>
	keyData === "\x1b[Z" || matchesKey(keyData, Key.shift("tab"));
/**
 * Space, in both the plain and Kitty/modifyOtherKeys encodings. Toggles a row
 * in `OptionSelector`'s multi-select mode. Comment mode is unaffected: it
 * consumes input first, and Space is already printable there.
 */
export const isSpaceKey = (keyData: string): boolean =>
	keyData === " " || decodeKittyPrintable(keyData) === " " || matchesKey(keyData, "space");

/**
 * Build a predicate matching a single unmodified printable character, in both
 * plain and Kitty/modifyOtherKeys encodings. Used for the questionnaire's `n`
 * note trigger.
 */
export function isCharKey(char: string): (keyData: string) => boolean {
	const lower = char.toLowerCase();
	return (keyData: string): boolean => {
		if (keyData.toLowerCase() === lower) return true;
		const decoded = decodeKittyPrintable(keyData);
		return decoded !== undefined && decoded.toLowerCase() === lower;
	};
}

/** Map a raw key to a 0-based option index for digit hotkeys, or undefined. */
export function digitIndex(keyData: string, optionCount: number): number | undefined {
	if (keyData.length !== 1 || keyData < "1" || keyData > "9") return undefined;
	const index = keyData.charCodeAt(0) - "1".charCodeAt(0);
	return index < optionCount ? index : undefined;
}

/**
 * Resolve a digit hotkey, transparently decoding Kitty/modifyOtherKeys
 * encodings of the same digit. Returns a 0-based index or undefined.
 */
export function resolveDigit(keyData: string, optionCount: number): number | undefined {
	const direct = digitIndex(keyData, optionCount);
	if (direct !== undefined) return direct;
	const decoded = decodeKittyPrintable(keyData);
	return decoded === undefined ? undefined : digitIndex(decoded, optionCount);
}

/** True when every character in the chunk is printable text (handles pastes). */
export function isPrintable(keyData: string): boolean {
	if (keyData.length === 0) return false;
	for (const char of keyData) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

/**
 * Drop the last character of a text-entry buffer, counting in code points.
 *
 * `slice(0, -1)` counts UTF-16 code units, so it splits a surrogate pair and
 * leaves a lone surrogate behind: the field renders a replacement glyph, one
 * visible character costs two backspaces, and the ill-formed string can still
 * be submitted — into a steering message, a tool result, or the reviewer
 * evidence another extension builds from it. Notes and free-text answers are
 * ordinary prose, so emoji in them are routine.
 *
 * Code points, not grapheme clusters: that matches how terminal line editors
 * delete, and it is what guarantees a well-formed result. A pre-existing lone
 * surrogate is removed as its own character rather than becoming undeletable.
 */
export function removeLastCharacter(text: string): string {
	if (text.length === 0) return text;
	// codePointAt on the second-to-last unit exceeds 0xFFFF exactly when the last
	// two units are a well-formed surrogate pair.
	const pairStart = text.length >= 2 ? text.codePointAt(text.length - 2) : undefined;
	return text.slice(0, pairStart !== undefined && pairStart > 0xffff ? -2 : -1);
}

/** Flatten pasted content into single-line note text. */
export function sanitizePaste(content: string): string {
	return content
		.replace(/\r\n|\r|\n|\t/g, " ")
		// eslint-disable-next-line no-control-regex
		.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Result of feeding one input chunk to the bracketed-paste state machine.
 * Exactly one of the three shapes applies:
 *
 *   - `buffer` present  — the paste is still in progress (no end marker yet);
 *     hold the buffer and feed the next chunk back in.
 *   - `text` present    — the paste completed; append the sanitized text. Any
 *     `rest` is ordinary input that arrived after the end marker and must be
 *     re-dispatched through normal key handling.
 */
export interface PasteChunk {
	/** Sanitized pasted text, present when the paste completed in this chunk. */
	text?: string;
	/** In-progress paste buffer, present while the end marker has not arrived. */
	buffer?: string;
	/** Ordinary input after the end marker, to be re-dispatched by the caller. */
	rest?: string;
}

/**
 * Advance a bracketed-paste buffer with one input chunk.
 *
 * pi-tui's Terminal re-wraps pasted content in `\x1b[200~ … \x1b[201~` before
 * it reaches a component's `handleInput`, and the markers can span chunks.
 * Returns `undefined` when the chunk is not part of a paste (no buffer in
 * progress and no start marker), in which case the caller proceeds with its
 * normal key handling. Every text-entry surface MUST route input through this
 * (directly or via `handleCommentKey`) — treating a paste chunk as a key
 * silently drops it, because it fails every key predicate.
 */
export function consumePasteChunk(buffer: string | undefined, keyData: string): PasteChunk | undefined {
	if (buffer === undefined) {
		const start = keyData.indexOf(PASTE_START);
		if (start === -1) return undefined;
		// Anything before the start marker is dropped, matching the historical
		// handleCommentKey behavior: it is stray input mid-paste, not typing.
		return consumePasteChunk("", keyData.slice(start + PASTE_START.length));
	}
	const combined = buffer + keyData;
	const end = combined.indexOf(PASTE_END);
	if (end === -1) return { buffer: combined };
	const rest = combined.slice(end + PASTE_END.length);
	const text = sanitizePaste(combined.slice(0, end));
	return rest ? { text, rest } : { text };
}

export interface CommentState {
	active: boolean;
	text: string;
	/** Present while buffering an in-progress bracketed paste. */
	pasteBuffer?: string;
}

export const idleCommentState = (): CommentState => ({ active: false, text: "" });

export type CommentKeyResult =
	| { state: CommentState; action: "none" }
	| { state: CommentState; action: "render" }
	| { state: CommentState; action: "submit"; comment: string };

/**
 * Comment-mode key handling. Tab exits comment mode preserving typed text;
 * Esc discards the note and returns to nav mode; Enter submits (comment is
 * trimmed; empty means "no note"); backspace edits; printable chunks append.
 * Everything else (arrows, control chords) is inert.
 */
export function handleCommentKey(state: CommentState, keyData: string): CommentKeyResult {
	// Bracketed pastes first — a paste chunk fails every key predicate below.
	const paste = consumePasteChunk(state.pasteBuffer, keyData);
	if (paste !== undefined) {
		if (paste.buffer !== undefined) {
			return { state: { active: true, text: state.text, pasteBuffer: paste.buffer }, action: "none" };
		}
		const pasted: CommentState = { active: true, text: state.text + (paste.text ?? "") };
		return paste.rest ? handleCommentKey(pasted, paste.rest) : { state: pasted, action: "render" };
	}
	if (isTabKey(keyData)) {
		return { state: { active: false, text: state.text }, action: "render" };
	}
	if (isEscapeKey(keyData)) {
		return { state: idleCommentState(), action: "render" };
	}
	if (isEnterKey(keyData)) {
		return { state: idleCommentState(), action: "submit", comment: state.text.trim() };
	}
	if (isBackspaceKey(keyData)) {
		return { state: { active: true, text: removeLastCharacter(state.text) }, action: "render" };
	}
	if (isPrintable(keyData)) {
		return { state: { active: true, text: state.text + keyData }, action: "render" };
	}
	// Kitty/modifyOtherKeys terminals may encode printable keys as CSI sequences.
	const decoded = decodeKittyPrintable(keyData);
	if (decoded !== undefined && isPrintable(decoded)) {
		return { state: { active: true, text: state.text + decoded }, action: "render" };
	}
	return { state, action: "none" };
}

/** Render the option label with a `1. ` prefix for the first nine options. */
export function numberLabel(option: string, index: number): string {
	return index < 9 ? `${index + 1}. ${option}` : `   ${option}`;
}

/**
 * True when every option already carries its own matching `N. ` ordinal
 * prefix (1-based, in order). Some callers pre-number their options — e.g.
 * @juicesharp/rpiv-ask-user-question's RPC fallback passes `1. label — desc`
 * strings to `ui.select` — and prefixing again would render `1. 1. label`.
 */
export function isPreNumbered(options: string[]): boolean {
	return options.length > 0 && options.every((option, i) => option.startsWith(`${i + 1}. `));
}
