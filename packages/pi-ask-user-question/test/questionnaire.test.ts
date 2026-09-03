import assert from "node:assert/strict";
import { test } from "node:test";
import { QuestionnaireSession } from "../questionnaire.ts";
import { CUSTOM_ANSWER_LABEL, type AskUserParams } from "../tool/schema.ts";

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
	],
};

test("rows are the authored options plus the appended custom-answer sentinel", () => {
	const rows = new QuestionnaireSession(params).rows();
	assert.equal(rows.length, 3);
	assert.deepEqual(
		rows.map((r) => r.label),
		["Postgres", "SQLite", CUSTOM_ANSWER_LABEL],
	);
});

test("the sentinel row is identifiable and authored options are not", () => {
	const session = new QuestionnaireSession(params);
	const rows = session.rows();
	assert.ok(session.isCustomRow(rows[2].value));
	assert.ok(!session.isCustomRow(rows[0].value));
	assert.ok(!session.isCustomRow("Postgres"));
});

function multiParams(): AskUserParams {
	return {
		questions: [
			params.questions[0],
			{ ...params.questions[0], header: "Cache", question: "Which cache?" },
		],
	};
}

test("the cursor wraps in both directions", () => {
	const session = new QuestionnaireSession(multiParams());
	session.previous();
	assert.equal(session.questionIndex, 1, "previous from the first wraps to the last");
	session.next();
	assert.equal(session.questionIndex, 0, "next from the last wraps to the first");
});

test("answers are keyed by question, so cycling back replaces the right one", () => {
	const session = new QuestionnaireSession(multiParams());
	session.recordAnswer("Postgres");
	session.next();
	session.recordAnswer("Redis");
	assert.ok(session.isComplete());
	session.previous();
	session.recordAnswer("SQLite");
	const answers = session.result().answers;
	assert.equal(answers.length, 2);
	assert.deepEqual(
		answers.map((a) => [a.questionIndex, a.answer]),
		[
			[0, "SQLite"],
			[1, "Redis"],
		],
		"answers stay in question order and the revisited one is replaced",
	);
});

test("advanceToUnanswered skips answered questions and reports completion", () => {
	const session = new QuestionnaireSession(multiParams());
	session.recordAnswer("Postgres");
	assert.equal(session.advanceToUnanswered(), true);
	assert.equal(session.questionIndex, 1);
	session.recordAnswer("Redis");
	assert.equal(session.advanceToUnanswered(), false, "nothing left to advance to");
});

test("isAnswered and answeredCount track progress for the tab strip", () => {
	const session = new QuestionnaireSession(multiParams());
	assert.equal(session.answeredCount(), 0);
	assert.ok(!session.isAnswered(0));
	session.recordAnswer("Postgres");
	assert.ok(session.isAnswered(0));
	assert.ok(!session.isAnswered(1));
	assert.equal(session.answeredCount(), 1);
});

test("recording an answer completes a single-question session", () => {
	const session = new QuestionnaireSession(params);
	assert.ok(!session.isComplete());
	session.recordAnswer("Postgres");
	assert.ok(session.isComplete());
	assert.deepEqual(session.result(), {
		answers: [{ questionIndex: 0, question: "Which database?", answer: "Postgres", custom: false }],
		cancelled: false,
	});
});

test("custom answers and notes are carried onto the recorded answer", () => {
	const session = new QuestionnaireSession(params);
	session.recordAnswer("DuckDB", { custom: true, notes: "analytics only" });
	const [answer] = session.result().answers;
	assert.equal(answer.answer, "DuckDB");
	assert.equal(answer.custom, true);
	assert.equal(answer.notes, "analytics only");
});

test("an absent note is omitted rather than stored as empty", () => {
	const session = new QuestionnaireSession(params);
	session.recordAnswer("Postgres");
	assert.ok(!("notes" in session.result().answers[0]));
});

test("cancelling preserves answers already given", () => {
	const session = new QuestionnaireSession(params);
	const cancelled = session.cancelledResult();
	assert.deepEqual(cancelled, { answers: [], cancelled: true });
});

test("the title omits the counter for a single question", () => {
	assert.equal(new QuestionnaireSession(params).title(), "Database");
});

test("the title carries an N of M counter when multiple questions exist", () => {
	const session = new QuestionnaireSession(multiParams());
	assert.equal(session.title(), "1 of 2 · Database");
	session.next();
	assert.equal(session.title(), "2 of 2 · Cache");
	assert.ok(!session.isComplete());
});

test("answering the same question twice replaces rather than appends", () => {
	const session = new QuestionnaireSession(params);
	session.recordAnswer("Postgres");
	session.recordAnswer("SQLite");
	assert.equal(session.result().answers.length, 1, "one question yields one answer");
	assert.equal(session.result().answers[0].answer, "SQLite");
});

test("result snapshots do not alias internal state", () => {
	const session = new QuestionnaireSession(params);
	session.recordAnswer("Postgres");
	session.result().answers.push({
		questionIndex: 9,
		question: "injected",
		answer: "x",
		custom: false,
	});
	assert.equal(session.result().answers.length, 1);
});

// ---------------------------------------------------------------------------
// Multi-select answers
// ---------------------------------------------------------------------------

const multiSelectParams: AskUserParams = {
	questions: [
		{
			question: "Which packages should change?",
			header: "Packages",
			multiSelect: true,
			options: [
				{ label: "pi-stats", description: "dashboard", preview: "# stats" },
				{ label: "pi-statusline", description: "footer" },
				{ label: "pi-plan-mode", description: "planning" },
			],
		},
	],
};

test("isMultiSelect reflects the question flag", () => {
	assert.equal(new QuestionnaireSession(multiSelectParams).isMultiSelect(), true);
	assert.equal(new QuestionnaireSession(params).isMultiSelect(), false);
});

test("a multi-select answer joins with a comma and records the parts", () => {
	const session = new QuestionnaireSession(multiSelectParams);
	session.recordMultiAnswer(["pi-stats", "pi-plan-mode"]);
	const [answer] = session.result().answers;
	assert.equal(answer.answer, "pi-stats, pi-plan-mode");
	assert.deepEqual(answer.selected, ["pi-stats", "pi-plan-mode"]);
	assert.equal(answer.custom, false);
	assert.ok(!("preview" in answer), "several previews concatenated are noise, not an answer");
});

test("a multi-select answer carries a note when one was typed", () => {
	const session = new QuestionnaireSession(multiSelectParams);
	session.recordMultiAnswer(["pi-stats"], { notes: "stats first" });
	assert.equal(session.result().answers[0].notes, "stats first");
});

test("revisiting a multi-select question replaces rather than appends", () => {
	const session = new QuestionnaireSession(multiSelectParams);
	session.recordMultiAnswer(["pi-stats", "pi-statusline"]);
	session.recordMultiAnswer(["pi-plan-mode"]);
	const answers = session.result().answers;
	assert.equal(answers.length, 1);
	assert.deepEqual(answers[0].selected, ["pi-plan-mode"]);
});

test("a mixed selection plus a typed value is custom, with the typed value last", () => {
	const session = new QuestionnaireSession(multiSelectParams);
	session.recordMultiAnswer(["pi-stats", "pi-plan-mode", "and also the docs site"], { custom: true });
	const [answer] = session.result().answers;
	assert.equal(answer.answer, "pi-stats, pi-plan-mode, and also the docs site");
	assert.equal(answer.custom, true, "custom means a typed value is among the parts");
	assert.equal(answer.selected?.at(-1), "and also the docs site");
});

test("an empty multi-select selection records nothing", () => {
	const session = new QuestionnaireSession(multiSelectParams);
	session.recordMultiAnswer([]);
	assert.ok(!session.isComplete());
	assert.deepEqual(session.result().answers, []);
});

test("recorded multi-select labels do not alias the caller's array", () => {
	const session = new QuestionnaireSession(multiSelectParams);
	const labels = ["pi-stats"];
	session.recordMultiAnswer(labels);
	labels.push("injected");
	assert.deepEqual(session.result().answers[0].selected, ["pi-stats"]);
});
