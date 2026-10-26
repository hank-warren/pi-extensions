/**
 * Which outside answers fit a questionnaire. Anything that does not answer every
 * question with what that question allows is dropped whole.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteQuestionnaires, resultFrom } from "../remote.ts";
import type { AskUserParams, QuestionnaireResult } from "../tool/schema.ts";

const params: AskUserParams = {
	questions: [
		{
			question: "Which database?",
			header: "Database",
			options: [
				{ label: "Postgres", description: "Relational" },
				{ label: "SQLite", description: "Embedded" },
			],
		},
		{
			question: "Which packages?",
			header: "Packages",
			multiSelect: true,
			options: [
				{ label: "pi-stats", description: "Stats" },
				{ label: "pi-statusline", description: "Footer" },
				{ label: "pi-stash", description: "Stash" },
			],
		},
	],
};

test("labels, typed text and notes map onto the terminal's answers", () => {
	const result = resultFrom(params, {
		id: "x",
		answers: [{ text: "DuckDB", notes: "see @docs/db.md" }, { choices: ["pi-stash", "pi-stats"], text: "pi-agents" }],
	});
	assert.deepEqual(result, {
		cancelled: false,
		answers: [
			{ questionIndex: 0, question: "Which database?", answer: "DuckDB", custom: true, notes: "see @docs/db.md" },
			{
				questionIndex: 1,
				question: "Which packages?",
				// Checked labels in the question's order, typed text last — as in the dialog.
				answer: "pi-stats, pi-stash, pi-agents",
				custom: true,
				selected: ["pi-stats", "pi-stash", "pi-agents"],
			},
		],
	});
});

test("answers that do not fit are rejected whole", () => {
	const bad: unknown[] = [
		[{ choice: "Postgres" }], // too few
		[{ choice: "MySQL" }, { choices: ["pi-stats"] }], // not an option
		[{ choice: "Postgres", text: "also this" }, { choices: ["pi-stats"] }], // both
		[{}, { choices: ["pi-stats"] }], // empty
		[{ choice: "Postgres" }, { choices: ["pi-stats", "nope"] }], // one bad check
		[{ choice: "Postgres" }, { choices: [] }], // nothing checked or typed
	];
	for (const answers of bad) {
		assert.equal(resultFrom(params, { id: "x", answers: answers as never }), undefined, JSON.stringify(answers));
	}
});

test("only an open questionnaire is answered, once", () => {
	const remote = new RemoteQuestionnaires();
	const settled: QuestionnaireResult[] = [];
	const end = remote.begin("q1", {
		params,
		settle: (result) => {
			settled.push(result);
			return true;
		},
	});
	const answer = { id: "q1", answers: [{ choice: "SQLite" }, { choice: "pi-stats" }] };
	assert.equal(remote.answer({ ...answer, id: "q2" }), false);
	assert.equal(remote.answer(answer), true);
	assert.equal(remote.answer(answer), false, "a settled questionnaire takes no second answer");
	end();
	assert.equal(settled.length, 1);
	assert.equal(settled[0].answers[1].answer, "pi-stats");
});
