/**
 * Parameter validation for `ask_user_question`. Pure — no pi imports, no I/O.
 *
 * typebox enforces structure (array bounds, required fields, types). This
 * module enforces the semantic rules typebox cannot express: the header chip's
 * length cap, non-empty text, reserved sentinel labels, and duplicates.
 *
 * Option labels are deliberately uncapped: the renderer wraps them and clamps
 * its own lines, so a length rule could only ever discard a questionnaire that
 * would have rendered fine.
 *
 * Violations return a structured error that becomes a normal tool error the
 * model can read and retry against — never a thrown exception, which would
 * surface as an opaque crash.
 */

import {
	type AskUserParams,
	MAX_HEADER_LENGTH,
	MAX_QUESTIONS,
	maxOptionsFor,
	MIN_OPTIONS,
	MIN_QUESTIONS,
	RESERVED_LABELS,
} from "./schema.ts";

type ValidationCode =
	| "bad_question_count"
	| "bad_option_count"
	| "header_too_long"
	| "empty_label"
	| "reserved_label"
	| "duplicate_label"
	| "empty_question";

interface ValidationError {
	code: ValidationCode;
	message: string;
}

const isReserved = (label: string): boolean =>
	(RESERVED_LABELS as readonly string[]).includes(label.trim().toLowerCase());

/**
 * Validate a params object. Returns the first violation, or undefined when the
 * questionnaire is well-formed. First-violation-only is deliberate: the model
 * fixes one thing per retry, and a wall of errors invites it to rewrite the
 * whole call rather than patch the offending field.
 */
export function validateParams(params: AskUserParams): ValidationError | undefined {
	const questions = params.questions;
	if (!Array.isArray(questions) || questions.length < MIN_QUESTIONS || questions.length > MAX_QUESTIONS) {
		return {
			code: "bad_question_count",
			message: `questions must contain ${MIN_QUESTIONS}-${MAX_QUESTIONS} entries; received ${questions?.length ?? 0}. Group questions that belong to one decision; ask further questions in a follow-up call.`,
		};
	}

	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const where = `questions[${i}]`;

		if (!q.question?.trim()) {
			return { code: "empty_question", message: `${where}.question must not be empty.` };
		}
		if (!q.header?.trim()) {
			return { code: "empty_question", message: `${where}.header must not be empty.` };
		}
		if (q.header.length > MAX_HEADER_LENGTH) {
			return {
				code: "header_too_long",
				message: `${where}.header is ${q.header.length} characters; the hard limit is ${MAX_HEADER_LENGTH}. Shorten it to a chip-sized tag.`,
			};
		}
		// The cap is mode-aware: checkboxes are a shortlist UI and get six, a
		// pick-one question still gets four.
		const maxOptions = maxOptionsFor(q.multiSelect);
		if (!Array.isArray(q.options) || q.options.length < MIN_OPTIONS || q.options.length > maxOptions) {
			const mode = q.multiSelect ? "multi-select" : "single-select";
			return {
				code: "bad_option_count",
				message: `${where}.options must contain ${MIN_OPTIONS}-${maxOptions} entries for a ${mode} question; received ${q.options?.length ?? 0}.`,
			};
		}

		const seen = new Set<string>();
		for (let j = 0; j < q.options.length; j++) {
			const option = q.options[j];
			const at = `${where}.options[${j}]`;
			if (!option.label?.trim()) {
				return { code: "empty_label", message: `${at}.label must not be empty.` };
			}
			if (isReserved(option.label)) {
				return {
					code: "reserved_label",
					message: `${at}.label "${option.label}" is reserved. A "Type something." row is appended automatically — do not author it.`,
				};
			}
			const key = option.label.trim().toLowerCase();
			if (seen.has(key)) {
				return {
					code: "duplicate_label",
					message: `${at}.label "${option.label}" duplicates an earlier option in the same question. Options must be distinct.`,
				};
			}
			seen.add(key);
		}
	}

	return undefined;
}
