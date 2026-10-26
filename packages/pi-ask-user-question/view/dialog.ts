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
 * TEXT ENTRY uses pi-tui's own `Editor` — the component behind pi's input box —
 * for both the custom answer and notes, so typing there behaves like typing a
 * prompt: multi-line (shift+enter), bracketed paste of any size, word motion,
 * undo, and `@` / path autocomplete from the session's working directory. The
 * hand-rolled single-line field it replaces dropped or flattened pastes and had
 * no cursor movement at all.
 *
 * KEY MAP (matches @juicesharp/rpiv-ask-user-question):
 *
 *   1-9         select an option (toggle it, on a multiSelect question)
 *   space       toggle the highlighted option    (multiSelect only)
 *   ↑ / ↓       move the highlight
 *   enter       confirm the highlight, or submit the checked options
 *   n           open the note editor (single-select: enter answers with the
 *               highlighted option; multi-select: enter keeps the note for submit)
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
	isCharKey,
	isEscapeKey,
	isLeftKey,
	isRightKey,
	isShiftTabKey,
	isTabKey,
} from "@hank-warren/pi-permission-selector/keys.ts";
import { OptionSelector, type SelectorOption } from "@hank-warren/pi-permission-selector/selector.ts";
import {
	type AutocompleteProvider,
	Editor,
	type EditorTheme,
	type SelectListTheme,
	type TUI,
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
	/**
	 * The host TUI, for the text editors (repaint and terminal height). Tests
	 * omit it and get a fixed-size stand-in.
	 */
	tui?: TUI;
	/** Editor chrome; hosts pass pi's select-list theme so autocomplete matches the input box. */
	editorTheme?: EditorTheme;
	/** Path and `@` completion for the text editors, rooted at the session's cwd. */
	autocomplete?: AutocompleteProvider;
}

/** Left/right border plus one space of padding on each side. */
const CHROME_COLUMNS = 4;
/** Opens the note editor. Tab is taken by question cycling. */
const NOTE_KEY = "n";
const isNoteKey = isCharKey(NOTE_KEY);
/** The selector never opens its own inline note: the dialog intercepts `n` and opens an Editor. */
const never = () => false;

/** Unstyled select-list theme for hosts (tests) that pass none. */
const plainSelectList: SelectListTheme = {
	selectedPrefix: (text) => text,
	selectedText: (text) => text,
	description: (text) => text,
	scrollInfo: (text) => text,
	noMatch: (text) => text,
};

/** Enough of a TUI for an Editor outside a terminal. */
const standInTui = { requestRender() {}, terminal: { rows: 40, columns: 100 } } as unknown as TUI;

/** An open text field: the custom answer, or a note on the highlighted option. */
interface Field {
	kind: "answer" | "note";
	editor: Editor;
}
/** Maximum rows the preview pane may occupy before it is clipped. */
const PREVIEW_MAX_ROWS = 12;

/** Per-question UI state, preserved while cycling between tabs. */
interface TabState {
	selector: OptionSelector;
	field?: Field;
	/**
	 * A note kept on a multi-select question until it is submitted (a
	 * single-select note answers straight away).
	 */
	note?: string;
	/** Note carried into the custom-answer field from the option list. */
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
	private isFocused = false;

	/** Focusable — set by the TUI when focus changes; passed on to an open editor (cursor, IME). */
	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		this.isFocused = value;
		const field = this.tabs[this.session.questionIndex]?.field;
		if (field) field.editor.focused = value;
	}

	private readonly opts: DialogOptions;
	private readonly tabs: TabState[] = [];
	private finished = false;

	constructor(opts: DialogOptions) {
		this.opts = opts;
		for (let i = 0; i < this.session.total; i++) this.tabs.push({ selector: this.buildSelector(i) });
	}

	private get session() {
		return this.opts.session;
	}

	private get tab(): TabState {
		return this.tabs[this.session.questionIndex];
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
			// The selector only advertises the note key; the dialog intercepts `n`
			// and opens an Editor instead of the selector's one-line note. Tab is
			// left unconsumed so this dialog can cycle questions with it.
			commentTrigger: never,
			commentKeyHint: NOTE_KEY,
			multiSelect,
			onSubmit: (checked) => this.submitChecked(index, checked),
			onSelect: (option) => this.select(index, option, this.tabs[index].note),
			onCancel: () => this.finish(session.cancelledResult()),
			requestRender: () => this.repaint(),
		});
	}

	/** A single-select pick, with the note typed for it, if any. */
	private select(index: number, option: SelectorOption, note?: string): void {
		const session = this.session;
		session.goTo(index);
		const tab = this.tabs[index];
		if (session.isCustomRow(option.value)) {
			// Enter free-text mode. A note typed on the sentinel row is carried
			// across so it is not silently lost.
			tab.pendingNotes = note;
			this.openField(tab, "answer");
			return;
		}
		session.recordAnswer(option.value, { notes: note });
		tab.note = undefined;
		this.afterAnswer();
	}

	/** A multi-select submit: the checked rows, plus the note kept on this question. */
	private submitChecked(index: number, checked: SelectorOption[]): void {
		const session = this.session;
		session.goTo(index);
		const tab = this.tabs[index];
		const labels = checked.filter((o) => !session.isCustomRow(o.value)).map((o) => o.label);
		if (checked.some((o) => session.isCustomRow(o.value))) {
			// Free-text mode with the other ticks held; Esc restores them.
			tab.pendingNotes = tab.note;
			tab.pendingSelected = labels;
			this.openField(tab, "answer");
			return;
		}
		session.recordMultiAnswer(labels, { notes: tab.note });
		tab.note = undefined;
		this.afterAnswer();
	}

	private openField(tab: TabState, kind: Field["kind"], text = ""): void {
		const editor = new Editor(this.opts.tui ?? standInTui, this.opts.editorTheme ?? { borderColor: (t) => this.style("dim", t), selectList: plainSelectList });
		if (this.opts.autocomplete) editor.setAutocompleteProvider(this.opts.autocomplete);
		if (text) editor.setText(text);
		editor.focused = this.isFocused;
		editor.onSubmit = (value) => this.commitField(tab, kind, value);
		tab.field = { kind, editor };
		this.repaint();
	}

	private closeField(tab: TabState): void {
		tab.field = undefined;
		tab.pendingNotes = undefined;
		tab.pendingSelected = undefined;
		this.repaint();
	}

	/** Enter in an open field. */
	private commitField(tab: TabState, kind: Field["kind"], value: string): void {
		const text = value.trim();
		const index = this.session.questionIndex;
		if (kind === "note") {
			tab.field = undefined;
			tab.note = text || undefined;
			// Single-select keeps the one-step "note, then enter answers" flow;
			// multi-select keeps the note until the checked rows are submitted.
			const selected = tab.selector.getSelected();
			if (!this.session.isMultiSelect() && selected) {
				this.select(index, selected, tab.note);
				return;
			}
			this.repaint();
			return;
		}
		if (text.length === 0) {
			// Empty custom answers are not submittable; keep the field open.
			tab.field?.editor.setText("");
			this.repaint();
			return;
		}
		if (tab.pendingSelected !== undefined) {
			// Append, never replace: the ticks the user left standing are part of
			// the answer, and the typed value goes last.
			this.session.recordMultiAnswer([...tab.pendingSelected, text], { custom: true, notes: tab.pendingNotes });
		} else {
			this.session.recordAnswer(text, { custom: true, notes: tab.pendingNotes });
		}
		tab.note = undefined;
		tab.field = undefined;
		tab.pendingNotes = undefined;
		tab.pendingSelected = undefined;
		this.afterAnswer();
	}

	/** Settle with an answer that came from outside the terminal (see remote.ts). */
	settle(result: QuestionnaireResult): void {
		this.finish(result);
	}

	/** Submit when everything is answered, else jump to the next gap. */
	private afterAnswer(): void {
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
		return this.tab?.field?.kind === "answer";
	}

	/** True while any text field owns the keyboard. */
	private isTyping(): boolean {
		return this.tab.field !== undefined;
	}

	invalidate(): void {
		for (const tab of this.tabs) {
			tab.selector.invalidate();
			tab.field?.editor.invalidate();
		}
	}

	private style(role: string, text: string): string {
		if (this.opts.theme) return this.opts.theme.fg(role, text);
		return role === "dim" ? `\x1b[2m${text}\x1b[0m` : text;
	}

	/** `✓ Database   ▸ Cache   ○ Queue` — one line, only when tabs exist. */
	private tabStrip(): string {
		const parts: string[] = [];
		for (let i = 0; i < this.session.total; i++) {
			const current = i === this.session.questionIndex;
			const mark = this.session.isAnswered(i) ? "✓" : current ? "▸" : "○";
			const label = `${mark} ${this.session.headerAt(i)}`;
			parts.push(current ? this.style("accent", label) : this.style("dim", label));
		}
		return parts.join("   ");
	}

	/** Inner content lines, before the box is drawn around them. */
	private contentLines(inner: number): string[] {
		const session = this.session;
		const lines: string[] = [this.style("accent", session.title())];
		if (session.total > 1) lines.push(this.tabStrip());
		lines.push("");
		lines.push(...wrapTextWithAnsi(session.current?.question ?? "", inner));
		lines.push("");

		const tab = this.tab;
		if (tab.field?.kind === "answer") {
			// The Editor wraps, scrolls and places the hardware cursor itself.
			lines.push(...tab.field.editor.render(inner));
			lines.push(...this.hint("enter submit · shift+enter new line · tab or @ paths · esc back to options", inner));
			return lines;
		}
		if (tab.field?.kind === "note") {
			const option = tab.selector.getSelected();
			const label = this.session.isMultiSelect() ? "Note for this question" : `Note on ${option?.label ?? "this option"}`;
			lines.push(this.style("accent", label));
			lines.push(...tab.field.editor.render(inner));
			const enter = this.session.isMultiSelect() ? "enter keep note" : "enter answer with note";
			lines.push(...this.hint(`${enter} · shift+enter new line · tab or @ paths · esc discard`, inner));
			return lines;
		}

		lines.push(...tab.selector.render(inner));
		if (tab.note) {
			for (const row of wrapTextWithAnsi(`note: ${tab.note}`, Math.max(1, inner - 2))) lines.push(this.style("dim", `  ${row}`));
		}
		lines.push(...this.previewLines(inner));
		if (session.total > 1 && !tab.selector.isCommenting()) {
			lines.push(this.style("dim", "  tab next · shift+tab prev question"));
		}
		return lines;
	}

	/** A dim key hint, wrapped so a narrow pane never truncates it. */
	private hint(text: string, inner: number): string[] {
		return wrapTextWithAnsi(text, Math.max(1, inner - 2)).map((row) => this.style("dim", `  ${row}`));
	}

	/** Preview markdown for the highlighted row, if it carries any. */
	private currentPreview(): string | undefined {
		const selected = this.tab.selector.getSelected();
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
		const outer = Math.max(20, Math.min(width, cap));
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
		const tab = this.tab;

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

		const field = tab.field;
		if (!field) {
			if (isNoteKey(keyData)) {
				this.openField(tab, "note", tab.note ?? "");
				return;
			}
			tab.selector.handleInput(keyData);
			return;
		}

		// A field is open. Esc unwinds one layer: it closes autocomplete first,
		// then the field (back to the option list, every tick intact) — never
		// the whole dialog. Everything else is the Editor's, which handles
		// pastes, multi-line input, motion and completion like pi's input box.
		if (isEscapeKey(keyData) && !field.editor.isShowingAutocomplete()) {
			this.closeField(tab);
			return;
		}
		field.editor.handleInput(keyData);
		this.repaint();
	}
}
