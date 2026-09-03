/**
 * LLM-facing result envelope.
 *
 * The string shapes here are deliberately identical to
 * @juicesharp/rpiv-ask-user-question's (`tool/response-envelope.ts`). Models
 * have seen this format across prior sessions, and preserving it means session
 * history replays without the assistant re-interpreting old tool results.
 * Treat the exact wording as pinned by tests, not as incidental.
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
 * Format a single answer as `"question"="answer"`, with the chosen option's
 * preview and the user's note appended when present. Order and wording match
 * rpiv's envelope and are pinned by tests.
 */
function buildAnswerSegment(a: QuestionAnswer): string {
	const parts: string[] = [`"${a.question}"="${a.answer}"`];
	if (a.preview && a.preview.length > 0) parts.push(`selected preview: ${a.preview}`);
	if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
	return `${parts.join(". ")}.`;
}

/**
 * Map a questionnaire outcome to the tool envelope. Cancelled and
 * zero-answers both collapse to DECLINE_MESSAGE so the model sees one
 * canonical "didn't answer" signal regardless of cause.
 */
export function buildResponse(
	result: QuestionnaireResult | null | undefined,
	params: AskUserParams,
): ToolResult {
	if (!result || result.cancelled) {
		return buildToolResult(DECLINE_MESSAGE, {
			answers: result?.answers ?? [],
			cancelled: true,
			...(result?.error ? { error: result.error } : {}),
		});
	}

	const segments: string[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const answer = result.answers.find((a) => a.questionIndex === i);
		if (answer) segments.push(buildAnswerSegment(answer));
	}
	if (segments.length === 0) {
		return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	}
	return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`, result);
}
