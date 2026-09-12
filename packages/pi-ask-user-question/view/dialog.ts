/**
 * The questionnaire dialog: a pi-tui component driven by QuestionnaireSession
 * and rendered through `ctx.ui.custom()`.
 *
 * NO MONKEY PATCHING. The numbered options, digit hotkeys and the note editor
 * come from `OptionSelector`, imported from the PUBLISHED sibling package
 * `@hank-warren/pi-permission-selector` (plain `dependencies`, never
 * `bundledDependencies` — AGENTS.md §Structure). See
 * docs/specs/pi-ask-user-question.md §9.
 *
 * KEY MAP (matches @juicesharp/rpiv-ask-user-question):
 *
 *   1-9         select an option (toggle it, on a multiSelect question)
 *   space       toggle the highlighted option    (multiSelect only)
 *   ↑ / ↓       move the highlight
 *   enter       confirm the highlight, or submit the checked options
 *   n           open the note editor for the highlighted option
 *   tab / →     next question      shift+tab / ←   previous question
 *   esc         decline the questionnaire
 *
 * Note that `n`, not Tab, opens notes here. Tab is reserved for cycling
 * questions. pi-auto-permissions approval prompts keep Tab-to-comment, because
 * they are single-question and have no tabs to cycle — `OptionSelector`
 * defaults to Tab and this dialog overrides it.
 *
 * THREE RULES, all learned from shipping bugs:
 *
 * 1. NEVER compare key data with `===`. Every key check goes through the
 *    shared predicates in `.../keys.ts`. Under the Kitty keyboard protocol
 *    (Ghostty's default) Esc is `\x1b[27u`, not `\x1b`, so raw comparisons
 *    trapped the user in the custom-answer field with no way out.
 * 2. ALWAYS pad rendered lines to the full width. The dialog is a rectangle,
 *    and a short line leaves whatever the renderer last drew in those columns
 *    visible inside the box — which is exactly how it looked when this was an
 *    overlay composited onto the chat.
 * 3. ALWAYS clamp lines to the inner width. A single over-long line breaks the
 *    right border and spills into the transcript, so `render` truncates as a
 *    last-resort invariant no matter what any content source produces.
 */

import {
	consumePasteChunk,
	isBackspaceKey,
	isCharKey,
	isEnterKey,
	isEscapeKey,
	isLeftKey,
	isPrintable,
	isRightKey,
	isShiftTabKey,
	isTabKey,
	removeLastCharacter,
} from "@hank-warren/pi-permission-selector/keys.ts";
import { OptionSelector, type SelectorOption } from "@hank-warren/pi-permission-selector/selector.ts";
import {
	CURSOR_MARKER,
	Input,
	SelectList,
	matchesKey,
	decodeKittyPrintable,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { QuestionnaireSession } from "../questionnaire.ts";
import type { QuestionnaireResult } from "../tool/schema.ts";

/** Structural subset of pi's Theme used here; keeps the view unit-testable. */
interface DialogTheme {
	fg(role: string, text: string): string;
}

interface DialogOptions {
	session: QuestionnaireSession;
	theme?: DialogTheme;
	/** Called exactly once with the final outcome. */
	done(result: QuestionnaireResult): void;
	requestRender?(): void;
	/**
	 * Optional width cap. Unset means fill the width the host gives us, which is
	 * what the full-width editor area wants.
	 */
	maxWidth?: number;
	/**
	 * Markdown theme for the preview pane. Hosts pass pi's `getMarkdownTheme()`;
	 * when omitted the preview renders as plain wrapped text, which keeps this
	 * component unit-testable without constructing a 14-function theme.
	 */
	markdownTheme?: MarkdownTheme;
}

/** Left/right border plus one space of padding on each side. */
const CHROME_COLUMNS = 4;
/** Indent for the custom-answer field, in columns. */
const FIELD_INDENT = "  ";
/** Opens the note editor. Tab is taken by question cycling. */
const NOTE_KEY = "n";
const isNoteKey = isCharKey(NOTE_KEY);
/** Maximum rows the preview pane may occupy before it is clipped. */
const PREVIEW_MAX_ROWS = 12;

/** Per-question UI state, preserved while cycling between tabs. */
interface TabState {
	selector?: OptionSelector;
	textInput?: Input;
	lastCustomText?: string;
	/** True only while forwarding input from the note editor to its callbacks. */
	submittingNote?: boolean;
	noteSeeded?: boolean;
	customText?: string;
	/**
	 * In-progress bracketed paste aimed at the custom-answer field. pi-tui wraps
	 * pastes in `\x1b[200~ … \x1b[201~` and the markers can span input chunks;
	 * a paste chunk fails every key predicate, so without this buffer pasting
	 * into the field was silently dropped (the note editor was unaffected —
	 * handleCommentKey buffers its own pastes).
	 */
	pasteBuffer?: string;
	pendingNotes?: string;
	/**
	 * Labels checked alongside the sentinel row on a multi-select question, held
	 * while the free-text field is open. Committed text is APPENDED to these
	 * rather than replacing them (amends spec §5.3), so "A, B, and also …" is
	 * one answer. Undefined means the field belongs to a single-select question.
	 */
	pendingSelected?: string[];
}

export class QuestionnaireDialog {
	/** Focusable — set by the TUI when focus changes. Drives CURSOR_MARKER. */
	focused = false;

	private readonly opts: DialogOptions;
	private readonly tabs = new Map<number, TabState>();
	private overview?: SelectList;
	private jumpInput?: Input;
	private editingFromOverview = false;
	private finished = false;

	constructor(opts: DialogOptions) {
		this.opts = opts;
	}

	private get session() {
		return this.opts.session;
	}

	private get tab(): TabState {
		const index = this.session.questionIndex;
		let tab = this.tabs.get(index);
		if (!tab) {
			tab = {};
			this.tabs.set(index, tab);
			if (this.session.current.mode === "text") {
				const input = new Input();
				input.onSubmit = (value) => {
					const text = value.trim();
					if (!text) return;
					this.session.recordAnswer(text, { custom: true });
					input.setValue(text);
					this.afterAnswer();
				};
				input.onEscape = () => {
					// Discard only the uncommitted edit; a second Esc in the overview cancels.
					input.setValue(this.session.answerAt(index)?.answer ?? "");
					tab!.pasteBuffer = undefined;
					this.openOverview(index);
				};
				tab.textInput = input;
			} else tab.selector = this.buildSelector(index);
		}
		return tab;
	}

	private repaint(): void {
		this.opts.requestRender?.();
	}

	private buildSelector(index: number): OptionSelector {
		const session = this.session;
		const previous = session.goTo.bind(session);
		// rows() reads the cursor, so snapshot this tab's rows at build time.
		const restore = session.questionIndex;
		previous(index);
		const options: SelectorOption[] = session.rows().map((row) => ({
			value: row.value,
			label: row.label,
			description: row.description,
		}));
		// Read the mode while the cursor is still parked on this tab's question.
		const multiSelect = session.isMultiSelect();
		previous(restore);

		return new OptionSelector({
			options,
			theme: this.opts.theme,
			// `n` instead of Tab; Tab must stay free for question cycling. Tab is
			// left unconsumed by the selector so this dialog can intercept it.
			commentTrigger: isNoteKey,
			commentKeyHint: NOTE_KEY,
			multiSelect,
			onSubmit: (checked, comment) => {
				session.goTo(index);
				const labels = checked.filter((o) => !session.isCustomRow(o.value)).map((o) => o.label);
				if (checked.some((o) => session.isCustomRow(o.value))) {
					// Free-text mode with the other ticks held; Esc restores them.
					this.tabs.get(index)!.pendingNotes = this.answerNotes(comment);
					this.tabs.get(index)!.pendingSelected = labels;
					this.tabs.get(index)!.customText = this.tabs.get(index)!.lastCustomText ?? "";
					this.repaint();
					return;
				}
				session.recordMultiAnswer(labels, { notes: this.answerNotes(comment) });
				this.afterAnswer();
			},
			onSelect: (option, comment) => {
				session.goTo(index);
				if (session.isCustomRow(option.value)) {
					// Enter free-text mode. A note typed on the sentinel row is
					// carried across so it is not silently lost.
					this.tabs.get(index)!.pendingNotes = this.answerNotes(comment);
					this.tabs.get(index)!.customText = this.tabs.get(index)!.lastCustomText ?? "";
					this.repaint();
					return;
				}
				session.recordAnswer(option.value, { notes: this.answerNotes(comment) });
				this.afterAnswer();
			},
			onCancel: () => this.finish(session.cancelledResult()),
			requestRender: () => this.repaint(),
		});
	}

	private answerNotes(comment?: string): string | undefined {
		return comment ?? (this.tab.submittingNote ? undefined : this.session.answerAt(this.session.questionIndex)?.notes);
	}

	/** Submit when everything is answered, unless this round requires review. */
	private afterAnswer(): void {
		if (this.editingFromOverview || (this.session.isComplete() && this.session.reviewBeforeSubmit)) {
			this.editingFromOverview = false;
			this.openOverview(this.session.questionIndex);
			return;
		}
		if (this.session.isComplete()) {
			this.finish(this.session.result());
			return;
		}
		this.session.advanceToUnanswered();
		this.repaint();
	}

	private finish(result: QuestionnaireResult): void {
		if (this.finished) return;
		this.finished = true;
		this.opts.done(result);
	}

	/** Cancel from an external lifecycle signal. Safe to call after user completion. */
	cancel(): void {
		this.finish(this.session.cancelledResult());
	}

	/** True while the free-text custom-answer editor is open. */
	isTypingCustom(): boolean {
		return this.tab?.customText !== undefined;
	}

	/** True while any text-entry mode owns the keyboard. */
	private isTyping(): boolean {
		return this.isTypingCustom() || this.tab.selector?.isCommenting() === true;
	}

	invalidate(): void {
		for (const tab of this.tabs.values()) {
			tab.selector?.invalidate();
			tab.textInput?.invalidate();
		}
		this.overview?.invalidate();
		this.jumpInput?.invalidate();
	}

	private style(role: string, text: string): string {
		if (this.opts.theme) return this.opts.theme.fg(role, text);
		return role === "dim" ? `\x1b[2m${text}\x1b[0m` : text;
	}

	/** Window the strip around the current tab, never truncate it off the right. */
	private tabStrip(inner: number): string {
		const current = this.session.questionIndex;
		const label = (i: number) => `${this.session.isAnswered(i) ? "✓" : i === current ? "▸" : "○"} ${this.session.headerAt(i)}`;
		let start = current;
		let end = current;
		let used = visibleWidth(label(current));
		// Reserve space for the omitted-neighbour markers.
		while (true) {
			const candidate = start > 0 ? start - 1 : end + 1;
			if (candidate >= this.session.total) break;
			const size = visibleWidth(label(candidate)) + 3;
			if (used + size + 4 > inner) break;
			if (candidate < start) start = candidate;
			else end = candidate;
			used += size;
		}
		const parts: string[] = [];
		for (let i = start; i <= end; i++) {
			parts.push(i === current ? this.style("accent", label(i)) : this.style("dim", label(i)));
		}
		return `${start > 0 ? "‹ " : ""}${parts.join("   ")}${end < this.session.total - 1 ? " ›" : ""}`;
	}

	private openOverview(index = this.session.questionIndex): void {
		const items = Array.from({ length: this.session.total }, (_, i) => {
			const answer = this.session.answerAt(i);
			return {
				value: String(i),
				label: `${i + 1}. ${answer ? "✓" : "○"} ${this.session.headerAt(i)}`,
				description: answer ? `${answer.answer}${answer.notes ? ` · Note: ${answer.notes}` : ""}` : "Unanswered",
			};
		});
		// A distinct final row makes submission deliberate, not another answer key.
		if (this.session.reviewBeforeSubmit) items.push({
			value: "submit", label: "Submit round", description: this.session.isComplete() ? "All questions answered" : "Answer every question first",
		});
		this.overview = new SelectList(items, 8, {
			selectedPrefix: (t) => this.style("accent", t),
			selectedText: (t) => this.style("accent", t),
			description: (t) => this.style("dim", t),
			scrollInfo: (t) => this.style("dim", t),
			noMatch: (t) => this.style("dim", t),
		});
		this.overview.setSelectedIndex(index);
		this.overview.onSelect = (item) => {
			if (item.value === "submit") {
				if (this.session.isComplete()) this.finish(this.session.result());
				return;
			}
			this.session.goTo(Number(item.value));
			this.overview = undefined;
			this.editingFromOverview = this.session.reviewBeforeSubmit;
			this.repaint();
		};
		this.overview.onCancel = () => this.cancel();
		this.repaint();
	}

	private overviewLines(inner: number): string[] {
		const lines = [this.style("accent", `${this.session.reviewBeforeSubmit ? "Review round" : "Question overview"} · ${this.session.answeredCount()}/${this.session.total} answered`), ""];
		lines.push(...this.overview!.render(inner), "");
		const selected = this.overview!.getSelectedItem();
		if (selected && selected.value !== "submit") {
			const index = Number(selected.value);
			const answer = this.session.answerAt(index);
			const details = [this.session.questionAt(index).question];
			if (answer) {
				// Show the parts independently: labels and custom text may themselves contain commas.
				if (answer.selected) details.push(...answer.selected.map((part) => `✓ ${part}`));
				else details.push(`Answer: ${answer.answer}`);
				if (answer.notes) details.push(`Note: ${answer.notes}`);
			} else details.push("Unanswered");
			for (const detail of details) lines.push(...wrapTextWithAnsi(detail, inner));
		}
		if (this.jumpInput) {
			this.jumpInput.focused = this.focused;
			lines.push("", ...wrapTextWithAnsi(`Question number (1-${this.session.total}):`, inner), ...this.jumpInput.render(inner));
			lines.push(...wrapTextWithAnsi("enter jump · esc back", inner));
		} else {
			lines.push("", ...wrapTextWithAnsi("↑↓ select · PgUp/PgDn page · Home/End · g jump · enter edit/submit · tab back · esc cancel", inner));
		}
		return lines;
	}

	private handleOverview(keyData: string): void {
		if (this.jumpInput) {
			this.jumpInput.handleInput(keyData);
		} else if (isCharKey("g")(keyData)) {
			const input = new Input();
			input.onEscape = () => { this.jumpInput = undefined; };
			input.onSubmit = (value) => {
				if (!/^\d+$/.test(value.trim())) return;
				const index = Number(value.trim()) - 1;
				if (index < 0 || index >= this.session.total) return;
				this.overview!.setSelectedIndex(index);
				this.jumpInput = undefined;
			};
			this.jumpInput = input;
		} else if (isTabKey(keyData)) {
			this.overview = undefined;
		} else if (matchesKey(keyData, "home")) {
			this.overview!.setSelectedIndex(0);
		} else if (matchesKey(keyData, "end")) {
			this.overview!.setSelectedIndex(this.session.total);
		} else if (matchesKey(keyData, "pageUp") || matchesKey(keyData, "pageDown")) {
			const selected = this.overview!.getSelectedItem()!.value;
			const index = selected === "submit" ? this.session.total : Number(selected);
			this.overview!.setSelectedIndex(index + (matchesKey(keyData, "pageUp") ? -8 : 8));
		} else this.overview!.handleInput(keyData);
		this.repaint();
	}

	/** Inner content lines, before the box is drawn around them. */
	private contentLines(inner: number): string[] {
		if (this.overview) return this.overviewLines(inner);
		const session = this.session;
		const lines: string[] = wrapTextWithAnsi(this.style("accent", session.title()), inner);
		if (session.total > 1) lines.push(...wrapTextWithAnsi(this.tabStrip(inner), inner));
		lines.push("");
		lines.push(...wrapTextWithAnsi(session.current?.question ?? "", inner));
		lines.push("");

		const tab = this.tab;
		if (tab.textInput) {
			tab.textInput.focused = this.focused;
			lines.push(...tab.textInput.render(inner), "");
			lines.push(...wrapTextWithAnsi("enter save answer · esc discard edit / overview", inner));
			return lines;
		}
		if (tab.customText !== undefined) {
			// Wrap the typed answer. Without this a long answer ran past the right
			// border and off the screen forever, because an input field renders as
			// one line unless something breaks it up.
			const avail = Math.max(1, inner - FIELD_INDENT.length - 1); // -1 reserves the caret cell
			const wrapped = wrapTextWithAnsi(tab.customText, avail);
			// CURSOR_MARKER is a zero-width APC sequence: the TUI strips it and
			// parks the hardware cursor there, so the caret lands in the field
			// instead of at the bottom of the screen.
			const caret = `${this.focused ? CURSOR_MARKER : ""}▌`;
			for (let i = 0; i < wrapped.length; i++) {
				const last = i === wrapped.length - 1;
				lines.push(`${FIELD_INDENT}${wrapped[i]}${last ? caret : ""}`);
			}
			lines.push("");
			lines.push(...wrapTextWithAnsi(this.style("dim", "  enter submit · esc back to options"), inner));
			return lines;
		}

		lines.push(...tab.selector!.render(inner));
		lines.push(...this.previewLines(inner));
		if (session.total > 1 && !tab.selector!.isCommenting()) {
			lines.push(...wrapTextWithAnsi(this.style("dim", "  tab next · shift+tab prev question"), inner));
		}
		if (!tab.selector!.isCommenting()) lines.push(...wrapTextWithAnsi("  o overview / jump", inner));
		return lines;
	}

	/** Preview markdown for the highlighted row, if it carries any. */
	private currentPreview(): string | undefined {
		const selected = this.tab.selector?.getSelected();
		if (!selected) return undefined;
		return this.session.rows().find((row) => row.value === selected.value)?.preview;
	}

	/**
	 * The preview pane: markdown between two rules, below the options.
	 *
	 * Stacked, not side-by-side. rpiv spent ~712 lines largely on making a
	 * two-column layout behave at narrow widths; stacking needs none of it
	 * (docs/specs/pi-ask-user-question.md §6.2).
	 */
	private previewLines(inner: number): string[] {
		const preview = this.currentPreview();
		if (!preview) return [];

		const rendered = this.renderMarkdown(preview, inner);

		// Cap the pane so a long preview cannot push the options off screen.
		const clipped = rendered.slice(0, PREVIEW_MAX_ROWS);
		if (rendered.length > PREVIEW_MAX_ROWS) {
			clipped.push(this.style("dim", `… ${rendered.length - PREVIEW_MAX_ROWS} more lines`));
		}

		const rule = this.style("dim", "─".repeat(Math.max(1, inner)));
		return ["", rule, ...clipped, rule];
	}

	/**
	 * Render preview markdown, falling back to plain wrapped text.
	 *
	 * The fallback is not just for hosts that pass no theme. pi's
	 * `getMarkdownTheme()` returns lazily-bound functions that throw
	 * "Theme not initialized" until `initTheme()` has run, and a throw inside
	 * `render()` would take down the entire dialog rather than one pane. A
	 * preview is a nicety; it must never be able to do that.
	 */
	private renderMarkdown(preview: string, inner: number): string[] {
		if (this.opts.markdownTheme) {
			try {
				return new Markdown(preview, 0, 0, this.opts.markdownTheme).render(inner);
			} catch {
				// fall through to plain text
			}
		}
		return preview.split("\n").flatMap((line) => wrapTextWithAnsi(line, inner));
	}

	render(width: number): string[] {
		const cap = this.opts.maxWidth ?? width;
		const outer = Math.max(1, Math.min(width, cap));
		if (outer < CHROME_COLUMNS + 1) return [truncateToWidth(this.session.title(), outer, "")];
		const inner = outer - CHROME_COLUMNS;
		const border = (text: string) => this.style("dim", text);

		const out: string[] = [border(`┌${"─".repeat(outer - 2)}┐`)];
		for (const raw of this.contentLines(inner)) {
			// Invariant (3): never let a line break the right border, whatever
			// produced it.
			const line = visibleWidth(raw) > inner ? truncateToWidth(raw, inner) : raw;
			// Invariant (2): pad to the full inner width, so every row of the box is
			// the same rectangle and nothing shows through beside a short line.
			const pad = Math.max(0, inner - visibleWidth(line));
			out.push(`${border("│")} ${line}${" ".repeat(pad)} ${border("│")}`);
		}
		out.push(border(`└${"─".repeat(outer - 2)}┘`));
		return out;
	}

	handleInput(keyData: string): void {
		if (this.finished) return;
		if (this.overview) { this.handleOverview(keyData); return; }
		const tab = this.tab;
		if (tab.textInput) {
			if (isEscapeKey(keyData)) {
				tab.textInput.onEscape?.();
				return;
			}
			// Buffer and sanitize paste before delegating to Input, whose native paste
			// path strips newlines (joining words) and retains terminal control bytes.
			const paste = consumePasteChunk(tab.pasteBuffer, keyData);
			if (paste !== undefined) {
				tab.pasteBuffer = paste.buffer;
				if (paste.text !== undefined) tab.textInput.handleInput(`\x1b[200~${paste.text.replace(/[\x80-\x9f]/g, "")}\x1b[201~`);
				if (paste.rest) this.handleInput(paste.rest);
			} else tab.textInput.handleInput(keyData);
			this.repaint();
			return;
		}
		if (!this.isTyping() && isCharKey("o")(keyData)) {
			this.openOverview();
			return;
		}

		// Question cycling. Deliberately NOT active while typing: Tab inside the
		// note editor means "back to options", and inside the custom-answer field
		// a stray Tab must never teleport the user to another question and strand
		// their half-typed text.
		if (this.session.total > 1 && !this.isTyping()) {
			if (isTabKey(keyData) || isRightKey(keyData)) {
				this.session.next();
				this.repaint();
				return;
			}
			if (isShiftTabKey(keyData) || isLeftKey(keyData)) {
				this.session.previous();
				this.repaint();
				return;
			}
		}

		if (tab.customText === undefined) {
			if (!tab.selector!.isCommenting() && isNoteKey(keyData)) {
				tab.selector!.handleInput(keyData);
				const notes = this.session.answerAt(this.session.questionIndex)?.notes;
				if (notes && !tab.noteSeeded) tab.selector!.handleInput(`\x1b[200~${notes}\x1b[201~`);
				tab.noteSeeded = true;
				return;
			}
			const wasCommenting = tab.selector!.isCommenting();
			// Only an actual note-editor submission can clear an existing note.
			// Tab backs out with a retained draft; confirming a choice afterward
			// must preserve the saved note, not treat it as an empty submission.
			tab.submittingNote = wasCommenting;
			try {
				tab.selector!.handleInput(keyData);
			} finally {
				tab.submittingNote = false;
				if (wasCommenting && !tab.selector!.isCommenting() && !isTabKey(keyData)) {
					tab.noteSeeded = false;
				}
			}
			return;
		}

		// Free-text mode. Every check below MUST use a shared predicate — see
		// rule 1. Esc unwinds to the option list rather than cancelling the
		// dialog: one Esc never discards more than one layer.
		//
		// Bracketed pastes come first: a paste chunk contains ESC, so it would
		// otherwise fall through every predicate into the inert branch and vanish.
		const paste = consumePasteChunk(tab.pasteBuffer, keyData);
		if (paste !== undefined) {
			tab.pasteBuffer = paste.buffer;
			if (paste.text !== undefined) {
				tab.customText += paste.text;
				this.repaint();
			}
			// Ordinary input after the end marker (e.g. a trailing Enter) goes back
			// through normal key handling.
			if (paste.rest) this.handleInput(paste.rest);
			return;
		}
		if (isEscapeKey(keyData)) {
			// Back to the option list. The selector still holds every tick, so a
			// multi-select question is exactly as the user left it.
			tab.customText = undefined;
			tab.pasteBuffer = undefined;
			tab.pendingNotes = undefined;
			tab.pendingSelected = undefined;
			this.repaint();
			return;
		}
		if (isEnterKey(keyData)) {
			const text = tab.customText.trim();
			if (text.length === 0) return; // Empty custom answers are not submittable.
			if (tab.pendingSelected !== undefined) {
				// Append, never replace: the ticks the user left standing are part of
				// the answer, and the typed value goes last.
				this.session.recordMultiAnswer([...tab.pendingSelected, text], {
					custom: true,
					notes: tab.pendingNotes,
				});
			} else {
				this.session.recordAnswer(text, { custom: true, notes: tab.pendingNotes });
			}
			tab.lastCustomText = text;
			tab.customText = undefined;
			tab.pasteBuffer = undefined;
			tab.pendingNotes = undefined;
			tab.pendingSelected = undefined;
			this.afterAnswer();
			return;
		}
		if (isBackspaceKey(keyData)) {
			// Code-point aware: a UTF-16 slice would split a surrogate pair and
			// leave a lone surrogate in the answer that reaches the model.
			tab.customText = removeLastCharacter(tab.customText);
			this.repaint();
			return;
		}
		if (isPrintable(keyData)) {
			tab.customText += keyData;
			this.repaint();
			return;
		}
		// Kitty/modifyOtherKeys terminals encode plain printables as CSI-u.
		const decoded = decodeKittyPrintable(keyData);
		if (decoded !== undefined && isPrintable(decoded)) {
			tab.customText += decoded;
			this.repaint();
		}
		// Anything else (arrows, unhandled chords) is inert — never inserted
		// into the field as literal escape-sequence garbage.
	}
}
