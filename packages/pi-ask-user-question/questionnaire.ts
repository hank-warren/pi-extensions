/**
 * Questionnaire session state — a plain mutable object, no reducer.
 *
 * @juicesharp/rpiv-ask-user-question spends ~1,500 lines on a Redux-style
 * reducer plus four selector modules for this. The state here is a cursor and
 * a sparse answer array; a reducer would add indirection without adding a
 * single testable guarantee.
 *
 * NAVIGATION MODEL. Questions are tabs, not a queue. The cursor moves freely
 * (Tab / Shift+Tab, wrapping), answers are stored BY QUESTION INDEX so
 * revisiting a question replaces its answer rather than appending a second
 * one, and the questionnaire is complete only when every question has an
 * answer. This mirrors the tab model of rpiv-ask-user-question.
 *
 * Pure: no pi imports, no rendering. The dialog drives it; tests drive it the
 * same way.
 */

import {
	type AskUserParams,
	CUSTOM_ANSWER_LABEL,
	CUSTOM_ANSWER_VALUE,
	MULTI_SELECT_JOIN,
	type QuestionAnswer,
	type QuestionnaireResult,
} from "./tool/schema.ts";

interface SelectableRow {
	value: string;
	label: string;
	description?: string;
	/** Markdown shown in the preview pane while this row is highlighted. */
	preview?: string;
}

export class QuestionnaireSession {
	private readonly params: AskUserParams;
	private index = 0;
	/** Sparse by design: `answers[i]` is undefined until question i is answered. */
	private readonly answers: Array<QuestionAnswer | undefined>;

	constructor(params: AskUserParams) {
		this.params = params;
		this.answers = new Array(params.questions.length).fill(undefined);
	}

	get questionIndex(): number {
		return this.index;
	}

	get total(): number {
		return this.params.questions.length;
	}

	get current() {
		return this.params.questions[this.index];
	}

	/** Move the cursor, wrapping at both ends. */
	goTo(index: number): void {
		if (this.total === 0) return;
		this.index = ((index % this.total) + this.total) % this.total;
	}

	next(): void {
		this.goTo(this.index + 1);
	}

	previous(): void {
		this.goTo(this.index - 1);
	}

	/** True once every question has an answer. */
	isComplete(): boolean {
		return this.answers.every((answer) => answer !== undefined);
	}

	isAnswered(index: number): boolean {
		return this.answers[index] !== undefined;
	}

	answeredCount(): number {
		return this.answers.filter((answer) => answer !== undefined).length;
	}

	/**
	 * Move to the next question without an answer, searching forward from the
	 * cursor and wrapping. Returns false when everything is answered, which the
	 * dialog treats as "submit".
	 */
	advanceToUnanswered(): boolean {
		for (let step = 1; step <= this.total; step++) {
			const candidate = (this.index + step) % this.total;
			if (!this.isAnswered(candidate)) {
				this.index = candidate;
				return true;
			}
		}
		return false;
	}

	/**
	 * Rows for the current question: the authored options plus the appended
	 * custom-answer sentinel. The sentinel is never an authored option — it is
	 * added here and stripped when recording, which is why validation rejects
	 * models that try to author it themselves.
	 */
	rows(): SelectableRow[] {
		const question = this.current;
		if (!question) return [];
		const rows: SelectableRow[] = question.options.map((option) => ({
			value: option.label,
			label: option.label,
			description: option.description,
			...(option.preview ? { preview: option.preview } : {}),
		}));
		rows.push({ value: CUSTOM_ANSWER_VALUE, label: CUSTOM_ANSWER_LABEL });
		return rows;
	}

	/** True when `value` is the appended custom-answer row. */
	isCustomRow(value: string): boolean {
		return value === CUSTOM_ANSWER_VALUE;
	}

	/** True when the current question renders as checkboxes. */
	isMultiSelect(): boolean {
		return this.current?.multiSelect === true;
	}

	/**
	 * Record (or replace) a multi-select answer.
	 *
	 * `answer` is the labels joined with `", "` — spec §5.4 — so `tool/envelope.ts`
	 * and every consumer of `details.answers` stay unchanged; `selected` carries
	 * the parts for anyone who wants them structured. `custom` means "a typed
	 * value is among the parts", not "the whole answer is free text".
	 *
	 * No preview is attached even when checked options declare one: concatenating
	 * several previews into one answer string is noise the model authored itself.
	 */
	recordMultiAnswer(labels: string[], opts: { custom?: boolean; notes?: string } = {}): void {
		const question = this.current;
		if (!question || labels.length === 0) return;
		this.answers[this.index] = {
			questionIndex: this.index,
			question: question.question,
			answer: labels.join(MULTI_SELECT_JOIN),
			custom: opts.custom === true,
			selected: [...labels],
			...(opts.notes ? { notes: opts.notes } : {}),
		};
	}

	/**
	 * Record (or replace) the answer for the current question. Replacement is
	 * the point: cycling back to a question and picking again must not leave
	 * two answers for one question in the envelope.
	 */
	recordAnswer(answer: string, opts: { custom?: boolean; notes?: string } = {}): void {
		const question = this.current;
		if (!question) return;
		// A custom typed answer never carries a preview; only a chosen option can.
		const preview = opts.custom
			? undefined
			: question.options.find((option) => option.label === answer)?.preview;
		this.answers[this.index] = {
			questionIndex: this.index,
			question: question.question,
			answer,
			custom: opts.custom === true,
			...(opts.notes ? { notes: opts.notes } : {}),
			...(preview ? { preview } : {}),
		};
	}

	/** The recorded answer for a question, if any. */
	answerAt(index: number): QuestionAnswer | undefined {
		return this.answers[index];
	}

	/** Header for question `index`, used by the tab strip. */
	headerAt(index: number): string {
		return this.params.questions[index]?.header ?? "";
	}

	/** Title line: `Header` alone, or `2 of 3 · Header` when there are tabs. */
	title(): string {
		const question = this.current;
		if (!question) return "";
		return this.total > 1
			? `${this.index + 1} of ${this.total} · ${question.header}`
			: question.header;
	}

	private collected(): QuestionAnswer[] {
		return this.answers.filter((answer): answer is QuestionAnswer => answer !== undefined);
	}

	/** Successful outcome. */
	result(): QuestionnaireResult {
		return { answers: this.collected(), cancelled: false };
	}

	/** Declined outcome, preserving any answers given before the cancel. */
	cancelledResult(): QuestionnaireResult {
		return { answers: this.collected(), cancelled: true };
	}
}
