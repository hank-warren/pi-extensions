/**
 * LLM-facing result envelope.
 *
 * The prefix, suffix and `"question"="answer"` segments follow
 * @juicesharp/rpiv-ask-user-question's (`tool/response-envelope.ts`), a shape
 * models already know. Departures: typed answers are marked, answers given
 * before a decline are kept, and a chosen preview is not echoed. Treat the
 * exact wording as pinned by tests, not as incidental.
 */

import type { AskUserParams, QuestionAnswer, QuestionnaireResult } from "./schema.ts";

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: QuestionnaireResult;
}

export function buildToolResult(text: string, details: QuestionnaireResult): ToolResult {
	return { content: [{ type: "text" as const, text }], details };
}

/**
 * Format a single answer as `"question"="answer"`, marking typed text and
 * appending the user's note. A chosen option's preview stays in `details`
 * only: the model wrote it, and the label already identifies it.
 */
function buildAnswerSegment(a: QuestionAnswer): string {
	const typed = !a.custom ? "" : a.selected ? " (includes text the user typed)" : " (typed by the user)";
	const parts: string[] = [`"${a.question}"="${a.answer}"${typed}`];
	if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
	return `${parts.join(". ")}.`;
}

/** Answer segments in question order. */
function segments(answers: readonly QuestionAnswer[], params: AskUserParams): string[] {
	const out: string[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const answer = answers.find((a) => a.questionIndex === i);
		if (answer) out.push(buildAnswerSegment(answer));
	}
	return out;
}

/**
 * Map a questionnaire outcome to the tool envelope. Cancelled and
 * zero-answers both lead with DECLINE_MESSAGE so the model sees one canonical
 * "didn't answer" signal; answers given before an Esc follow it, so they are
 * not lost.
 */
export function buildResponse(
	result: QuestionnaireResult | null | undefined,
	params: AskUserParams,
): ToolResult {
	if (!result || result.cancelled) {
		const given = segments(result?.answers ?? [], params);
		const text = given.length > 0
			? `${DECLINE_MESSAGE}. Before declining, the user answered: ${given.join(" ")}`
			: DECLINE_MESSAGE;
		return buildToolResult(text, {
			answers: result?.answers ?? [],
			cancelled: true,
			...(result?.error ? { error: result.error } : {}),
		});
	}

	const answered = segments(result.answers, params);
	if (answered.length === 0) {
		return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	}
	return buildToolResult(`${ENVELOPE_PREFIX} ${answered.join(" ")} ${ENVELOPE_SUFFIX}`, result);
}
