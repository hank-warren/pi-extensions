/**
 * Tool parameter schema and shared types for `ask_user_question`.
 *
 * v0.2 scope (docs/specs/pi-ask-user-question.md §14): up to four questions,
 * single- or multi-select, optional per-option preview. Questions render as
 * tabs the user cycles with Tab / Shift+Tab.
 */

import { Type } from "typebox";

/** Canonical tool name — single source of truth, shared with reconcile.ts. */
export const TOOL_NAME = "ask_user_question";

export const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
/**
 * Multi-select questions get a larger cap. Checkboxes are a shortlist UI, not a
 * pick-one UI, so six is where a list stops fitting comfortably above the input
 * dock — not where it stops being a decision.
 */
const MAX_MULTI_OPTIONS = 6;
export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 4;

/** Upper bound on authored options for a question, by mode. */
export const maxOptionsFor = (multiSelect?: boolean): number =>
	multiSelect ? MAX_MULTI_OPTIONS : MAX_OPTIONS;

export const MAX_HEADER_LENGTH = 16;

/**
 * Labels the model may not author, because the dialog appends its own
 * custom-answer row. Compared case-insensitively after trimming.
 */
export const RESERVED_LABELS = ["other", "type something", "type something."] as const;

/** Label of the auto-appended custom-answer row. */
export const CUSTOM_ANSWER_LABEL = "Type something.";
/** Sentinel `value` for that row; never collides with a real option value. */
export const CUSTOM_ANSWER_VALUE = "\u0000custom-answer";

/** Separator joining a multi-select answer's labels into `answer` (spec §5.4). */
export const MULTI_SELECT_JOIN = ", ";

const OptionSchema = Type.Object({
	label: Type.String({
		description:
			"The display text for this option that the user will see and select. Aim for 1-5 words, but there is no hard limit: a longer label is fine when it genuinely helps, and long labels wrap in the dialog rather than being rejected.",
	}),
	description: Type.String({
		description:
			"Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
	}),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional markdown shown in a pane below the options while this option is highlighted. Use for concrete artifacts the user needs to compare: ASCII mockups, code snippets, diagram or configuration variations. Do NOT use it for simple preference questions where the label and description already say enough.",
		}),
	),
});

const QuestionSchema = Type.Object({
	question: Type.String({
		description:
			"The complete question to ask the user. Should be clear, specific, and end with a question mark.",
	}),
	header: Type.String({
		description:
			'MAX 16 CHARACTERS — hard limit, requests over the limit are rejected. Very short chip/tag shown next to the question. Examples: "Auth method", "Library", "Approach".',
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			description:
				"Render this question as checkboxes so the user can pick more than one option. Use it when several answers can hold at once (\"which of these should change\", \"which checks to run before merging\"); keep mutually exclusive choices single-select. Multi-select questions may have 2-6 options instead of 2-4. The user toggles rows with Space or a digit and confirms with Enter, and the answer comes back as the chosen labels joined with \", \".",
		}),
	),
	options: Type.Array(OptionSchema, {
		description:
			"The available choices for this question. Must have 2-4 options (2-6 when multiSelect is true), each a distinct choice; without multiSelect they must also be mutually exclusive. The 'Type something.' row is appended automatically — do NOT author it.",
		minItems: MIN_OPTIONS,
		maxItems: MAX_MULTI_OPTIONS,
	}),
});

export const QuestionParamsSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description:
			"Questions to ask the user. 1-4 questions; the user cycles between them with Tab and answers each one.",
		minItems: MIN_QUESTIONS,
		maxItems: MAX_QUESTIONS,
	}),
});

interface OptionParams {
	label: string;
	description: string;
	preview?: string;
}

interface QuestionParams {
	question: string;
	header: string;
	/** Checkbox mode: the user may check several options. Default false. */
	multiSelect?: boolean;
	options: OptionParams[];
}

export interface AskUserParams {
	questions: QuestionParams[];
}

/** One answered question. `custom` marks a typed free-text answer. */
export interface QuestionAnswer {
	questionIndex: number;
	question: string;
	answer: string;
	custom: boolean;
	/** Trimmed note, when the user attached one. */
	notes?: string;
	/** Preview text of the chosen option, when it carried one. */
	preview?: string;
	/**
	 * The individual chosen labels, present only on multi-select answers.
	 * `answer` holds the same list joined with `", "`, so every existing
	 * consumer of `answer` — including the envelope — is unchanged.
	 */
	selected?: string[];
}

export interface QuestionnaireResult {
	answers: QuestionAnswer[];
	cancelled: boolean;
	/** Set only on infrastructure failures, never on a user decline. */
	error?: "no_ui" | "no_custom_ui" | "invalid_params";
}
