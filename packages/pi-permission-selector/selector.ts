/**
 * OptionSelector — a composable pi-tui component with numbered options,
 * digit hotkeys, Tab-to-comment, and an opt-in checkbox multi-select mode.
 *
 * PUBLIC EXPORT SURFACE — treat as a frozen contract. Consumed by sibling
 * packages through the *published* npm package
 * (`@hank-warren/pi-permission-selector`), never by relative source import;
 * see `AGENTS.md` §Conventions and `docs/specs/pi-ask-user-question.md` §9.
 *
 * This replaced the retired `selector-patch.ts`, which monkey-patched pi's
 * `ExtensionSelectorComponent` (once the only way to affect `ctx.ui.select`,
 * since pi exposes no `setSelectorComponent` hook). Callers render this
 * through `ctx.ui.custom()` and get the same key behavior by composition:
 *
 *     const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) =>
 *         new OptionSelector({
 *             title: "…",
 *             options: [{ value: "allow", label: "Allow" }],
 *             theme,
 *             onSelect: (opt, comment) => { … ; done(opt.value); },
 *             onCancel: () => done(null),
 *         }));
 *
 * Rendering is intentionally string-based rather than delegating to pi-tui's
 * `SelectList`: `SelectList` owns its own `handleInput` and offers no hook to
 * intercept digits or enter comment mode without re-patching, which is exactly
 * what this component exists to avoid.
 */

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	type CommentState,
	COMMENT_CURSOR,
	handleCommentKey,
	idleCommentState,
	isDownKey,
	isEnterKey,
	isEscapeKey,
	isSpaceKey,
	isTabKey,
	isUpKey,
	numberLabel,
	resolveDigit,
} from "./keys.ts";

/** One selectable row. `value` is what the caller gets back; `label` is shown. */
export interface SelectorOption {
	value: string;
	label: string;
	description?: string;
}

/** Minimal structural subset of pi's Theme that this component needs. */
export interface SelectorTheme {
	fg(role: string, text: string): string;
}

export interface OptionSelectorOptions {
	/** Rendered above the options. Multi-line is fine. */
	title?: string;
	options: SelectorOption[];
	/** Enables the note editor. Default true. */
	allowComment?: boolean;
	/**
	 * Predicate that opens the note editor. Defaults to Tab, which is the
	 * established binding for pi-auto-permissions approval prompts and must not
	 * change. The questionnaire overrides this with `n` so Tab is free to cycle
	 * between questions, matching @juicesharp/rpiv-ask-user-question.
	 *
	 * Keys this predicate does not match are left unconsumed, so a host can
	 * intercept them before delegating here.
	 */
	commentTrigger?: (keyData: string) => boolean;
	/** Key name shown in the hint line for the note editor. Defaults to "tab". */
	commentKeyHint?: string;
	/** Enables `1`-`9` instant-select. Default true. */
	digitHotkeys?: boolean;
	/** Extra lines rendered between the options and the key hint. */
	footer?: string[];
	theme?: SelectorTheme;
	/**
	 * Opt-in checkbox mode. Default false; every existing caller is unaffected.
	 *
	 * In this mode rows render as `→ [x] 1. Label`, Space and `1`-`9` both
	 * toggle (a digit also moves the highlight and no longer commits), and
	 * Enter calls `onSubmit` with the checked options in list order.
	 */
	multiSelect?: boolean;
	/**
	 * Invoked on Enter or a digit hotkey in single-select mode. `comment` is the
	 * trimmed Tab-to-comment note, or undefined when none was typed.
	 *
	 * Required unless `multiSelect` is set.
	 */
	onSelect?(option: SelectorOption, comment?: string): void;
	/**
	 * Invoked on Enter in multi-select mode with the checked options in list
	 * order. Never called with an empty selection — Enter is inert until at
	 * least one row is checked. Required when `multiSelect` is set.
	 */
	onSubmit?(options: SelectorOption[], comment?: string): void;
	/** Invoked on Esc from navigation mode. */
	onCancel?(): void;
	/** Called when the component needs a repaint. Wire to `tui.requestRender()`. */
	requestRender?(): void;
}

const ANSI_RESET = "\x1b[0m";
const ANSI_ACCENT = "\x1b[36m";
const ANSI_DIM = "\x1b[2m";

function styler(theme: SelectorTheme | undefined, role: string, fallback: string) {
	return (text: string): string => (theme ? theme.fg(role, text) : `${fallback}${text}${ANSI_RESET}`);
}

export class OptionSelector {
	private selectedIndex = 0;
	/** Checked row indices in multi-select mode; always empty otherwise. */
	private readonly checked = new Set<number>();
	private comment: CommentState = idleCommentState();
	private readonly opts: OptionSelectorOptions;
	private readonly accent: (text: string) => string;
	private readonly text: (text: string) => string;
	private readonly dim: (text: string) => string;

	constructor(opts: OptionSelectorOptions) {
		this.opts = opts;
		this.accent = styler(opts.theme, "accent", ANSI_ACCENT);
		this.text = styler(opts.theme, "text", "");
		this.dim = styler(opts.theme, "dim", ANSI_DIM);
	}

	/** Currently highlighted option, or undefined when the list is empty. */
	getSelected(): SelectorOption | undefined {
		return this.opts.options[this.selectedIndex];
	}

	/** Move the highlight, clamped to the list. Used by tests and hosts. */
	setSelectedIndex(index: number): void {
		const max = this.opts.options.length - 1;
		this.selectedIndex = Math.max(0, Math.min(index, max));
	}

	/** True while the inline comment editor is open. */
	isCommenting(): boolean {
		return this.comment.active;
	}

	/** Checked options in list order. Always empty outside multi-select mode. */
	getChecked(): SelectorOption[] {
		return this.opts.options.filter((_, i) => this.checked.has(i));
	}

	/** True when row `index` is checked. Multi-select only. */
	isChecked(index: number): boolean {
		return this.checked.has(index);
	}

	/** Toggle row `index`. No-op outside multi-select mode or out of range. */
	toggle(index: number): void {
		if (!this.opts.multiSelect) return;
		if (index < 0 || index >= this.opts.options.length) return;
		if (this.checked.has(index)) this.checked.delete(index);
		else this.checked.add(index);
	}

	invalidate(): void {
		// No cached render state; nothing to drop.
	}

	private allowComment(): boolean {
		return this.opts.allowComment !== false;
	}

	private opensComment(keyData: string): boolean {
		return (this.opts.commentTrigger ?? isTabKey)(keyData);
	}

	private repaint(): void {
		this.opts.requestRender?.();
	}

	private commit(option: SelectorOption, comment?: string): void {
		this.opts.onSelect?.(option, comment && comment.length > 0 ? comment : undefined);
	}

	/** Multi-select terminal path. Inert with nothing checked. */
	private submit(comment?: string): void {
		const checked = this.getChecked();
		if (checked.length === 0) return;
		this.opts.onSubmit?.(checked, comment && comment.length > 0 ? comment : undefined);
	}

	/**
	 * Width of the fixed prefix drawn before every option label — pointer, then
	 * the checkbox in multi-select mode, then the ordinal. Wrapped rows and
	 * descriptions indent by exactly this much so they line up under the label
	 * rather than under a hardcoded five columns.
	 */
	private rowIndent(): string {
		const pointer = 2;
		const checkbox = this.opts.multiSelect ? 4 : 0;
		const ordinal = this.opts.digitHotkeys === false ? 0 : 3;
		return " ".repeat(pointer + checkbox + ordinal);
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const indent = this.rowIndent();
		// Titles wrap for the same reason rows, descriptions, and the hint do:
		// callers put arbitrary prose here (pi-auto-permissions includes reviewer
		// failure details and the full command), and pi-tui hard-crashes the whole
		// session on any rendered line wider than the terminal.
		if (this.opts.title) {
			for (const line of this.opts.title.split("\n")) {
				if (line.length === 0) lines.push("");
				else lines.push(...wrapTextWithAnsi(line, Math.max(1, width)));
			}
			lines.push("");
		}

		for (let i = 0; i < this.opts.options.length; i++) {
			const option = this.opts.options[i];
			const isSelected = i === this.selectedIndex;
			let label = this.opts.digitHotkeys === false ? option.label : numberLabel(option.label, i);
			// Checkbox sits between the pointer and the ordinal: `→ [x] 1. Label`.
			if (this.opts.multiSelect) label = `${this.checked.has(i) ? "[x]" : "[ ]"} ${label}`;
			// The in-progress note renders inline on the highlighted row, matching
			// the monkey-patch presentation exactly: `→ 1. Allow, note▌`.
			if (isSelected && this.comment.active) label = `${label}, ${this.comment.text}${COMMENT_CURSOR}`;
			// Wrap rather than overflow. A typed note has no length limit, so an
			// unwrapped row runs past the caller's box and is truncated or spills
			// into whatever is behind it.
			const style = isSelected ? this.accent : this.text;
			for (const segment of wrapRow(isSelected ? `→ ${label}` : `  ${label}`, width, indent)) {
				lines.push(style(segment));
			}
			// Descriptions wrap for the same reason labels do: cutting authored
			// prose off at the box edge silently throws away what the caller wrote.
			if (option.description && !this.comment.active) {
				for (const segment of wrapRow(`${indent}${option.description}`, width, indent)) {
					lines.push(this.dim(segment));
				}
			}
		}

		if (this.opts.footer?.length) lines.push("", ...this.opts.footer);

		// The hint grows with every enabled feature, so wrap it as well: on a
		// narrow dialog an unwrapped hint overflows exactly like a long note did.
		for (const segment of wrapRow(`  ${this.keyHint()}`, width, "  ")) {
			lines.push(this.dim(segment));
		}
		return lines;
	}

	private keyHint(): string {
		if (this.comment.active) return "enter submit · esc discard note · tab back";
		const parts: string[] = [];
		if (this.opts.multiSelect) {
			parts.push(this.opts.digitHotkeys === false ? "space toggle" : "space/1-9 toggle");
			parts.push("↑↓ move", `enter confirm (${this.checked.size})`);
		} else {
			if (this.opts.digitHotkeys !== false) parts.push("1-9 select");
			parts.push("↑↓ move", "enter confirm");
		}
		if (this.allowComment()) parts.push(`${this.opts.commentKeyHint ?? "tab"} add note`);
		parts.push("esc cancel");
		return parts.join(" · ");
	}

	handleInput(keyData: string): void {
		// Comment mode owns all input while active, so typed digits and `q`
		// land in the note instead of triggering navigation.
		if (this.comment.active) {
			const result = handleCommentKey(this.comment, keyData);
			this.comment = result.state;
			if (result.action === "submit") {
				if (this.opts.multiSelect) {
					this.submit(result.comment);
					this.repaint();
					return;
				}
				const selected = this.getSelected();
				if (selected) this.commit(selected, result.comment);
				return;
			}
			if (result.action === "render") this.repaint();
			return;
		}

		if (this.allowComment() && this.opensComment(keyData)) {
			this.comment = { active: true, text: this.comment.text };
			this.repaint();
			return;
		}
		if (isEscapeKey(keyData)) {
			this.opts.onCancel?.();
			return;
		}
		if (isUpKey(keyData)) {
			this.setSelectedIndex(this.selectedIndex - 1);
			this.repaint();
			return;
		}
		if (isDownKey(keyData)) {
			this.setSelectedIndex(this.selectedIndex + 1);
			this.repaint();
			return;
		}
		if (this.opts.multiSelect && isSpaceKey(keyData)) {
			this.toggle(this.selectedIndex);
			this.repaint();
			return;
		}
		if (isEnterKey(keyData)) {
			if (this.opts.multiSelect) {
				this.submit();
				return;
			}
			const selected = this.getSelected();
			if (selected) this.commit(selected);
			return;
		}
		if (this.opts.digitHotkeys !== false) {
			const index = resolveDigit(keyData, this.opts.options.length);
			if (index !== undefined) {
				this.selectedIndex = index;
				// A digit toggles rather than commits in multi-select mode, so one
				// keystroke can never end a multi-answer question prematurely.
				if (this.opts.multiSelect) {
					this.toggle(index);
					this.repaint();
					return;
				}
				const selected = this.opts.options[index];
				if (selected) this.commit(selected);
			}
		}
	}
}

/** Continuation indent for wrapped option rows, aligning under the label. */
const ROW_CONTINUATION_INDENT = "     ";

/**
 * Wrap one option row, indenting continuation lines so a wrapped note reads as
 * part of its row rather than as a new option. Exported for tests.
 */
export function wrapRow(text: string, width: number, indent = ROW_CONTINUATION_INDENT): string[] {
	const usable = Math.max(1, width - indent.length);
	const segments = wrapTextWithAnsi(text, usable);
	return segments.map((segment, i) => (i === 0 ? segment : `${indent}${segment}`));
}
