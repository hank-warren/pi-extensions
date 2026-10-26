/**
 * Remote answers: another extension in the same pi process (for example one
 * that relays the questionnaire to the user's phone) may answer an open
 * questionnaire by its id. The terminal dialog stays live; whichever answer
 * comes first settles it, and a remote answer produces exactly the tool result
 * a terminal answer would.
 *
 * An answer is honoured only for a questionnaire that is open right now, and
 * only when it answers every question with what that question allows: one of
 * its option labels, typed text, or (multi-select) several labels plus
 * optional text. Anything else is dropped, never half-applied.
 */

import { ASK_USER_ANSWER_EVENT, type AskUserRemoteAnswer, type AskUserRemoteQuestionAnswer } from "./events.ts";
import { QuestionnaireSession } from "./questionnaire.ts";
import type { AskUserParams, QuestionnaireResult } from "./tool/schema.ts";

interface Events {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

interface OpenQuestionnaire {
	params: AskUserParams;
	/** Settles the dialog; false when it had already settled. */
	settle(result: QuestionnaireResult): boolean;
}

export class RemoteQuestionnaires {
	private readonly open = new Map<string, OpenQuestionnaire>();

	/** Subscribe to the answer channel. Inert while nothing is open. */
	listen(events: Events): () => void {
		return events.on(ASK_USER_ANSWER_EVENT, (data) => {
			this.answer(data);
		});
	}

	begin(id: string, entry: OpenQuestionnaire): () => void {
		this.open.set(id, entry);
		return () => {
			this.open.delete(id);
		};
	}

	/** Apply an answer; true when it settled an open questionnaire. */
	answer(data: unknown): boolean {
		if (!isRecord(data) || typeof data.id !== "string") return false;
		const entry = this.open.get(data.id);
		if (!entry) return false;
		const result = data.cancelled === true ? cancelled(entry.params) : resultFrom(entry.params, data as unknown as AskUserRemoteAnswer);
		if (!result) return false;
		if (!entry.settle(result)) return false;
		this.open.delete(data.id);
		return true;
	}
}

function cancelled(params: AskUserParams): QuestionnaireResult {
	return new QuestionnaireSession(params).cancelledResult();
}

/** The result a terminal user would produce with these answers, or undefined when they don't fit. */
export function resultFrom(params: AskUserParams, answer: AskUserRemoteAnswer): QuestionnaireResult | undefined {
	const answers = answer.answers;
	if (!Array.isArray(answers) || answers.length !== params.questions.length) return undefined;
	const session = new QuestionnaireSession(params);
	for (let i = 0; i < params.questions.length; i++) {
		const question = params.questions[i];
		const given = answers[i];
		if (!isRecord(given)) return undefined;
		const labels = question.options.map((o) => o.label);
		const text = typeof given.text === "string" ? given.text.trim() : "";
		const notes = typeof given.notes === "string" && given.notes.trim() ? given.notes.trim() : undefined;
		session.goTo(i);
		if (question.multiSelect) {
			const picked = chosen(given, labels);
			if (picked === undefined) return undefined;
			const parts = text ? [...picked, text] : picked;
			if (parts.length === 0) return undefined;
			session.recordMultiAnswer(parts, { custom: text.length > 0, notes });
		} else {
			const choice = typeof given.choice === "string" ? given.choice : undefined;
			if (choice !== undefined && text) return undefined; // one answer, not both
			if (choice !== undefined) {
				if (!labels.includes(choice)) return undefined;
				session.recordAnswer(choice, { notes });
			} else if (text) {
				session.recordAnswer(text, { custom: true, notes });
			} else {
				return undefined;
			}
		}
	}
	return session.result();
}

/** Multi-select labels, in the question's order; undefined when any is not an option. */
function chosen(given: AskUserRemoteQuestionAnswer, labels: string[]): string[] | undefined {
	const raw = given.choices ?? (typeof given.choice === "string" ? [given.choice] : []);
	if (!Array.isArray(raw) || raw.some((c) => typeof c !== "string" || !labels.includes(c))) return undefined;
	return labels.filter((label) => raw.includes(label));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
