/**
 * The menus: the screens as pure builders, and one pass through the real TUI
 * runtime.
 *
 * The screen builders carry the contract — the set of choices a human is
 * offered — and pinning them here is cheap and impossible through a terminal.
 * The drive-through at the bottom is the other half: it proves the review menu
 * really resolves to a decision rather than only looking right on paper.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockContext } from "../../../test/support/mock-pi.js";
import {
	proposedDocumentScreen,
	recoveryScreen,
	type ReviewMenuSummary,
	showTaskReviewMenu,
	taskReviewScreen,
	tasksMenuScreen,
} from "../src/task-menus.js";

const SUMMARY: ReviewMenuSummary = {
	reason: "drop the cutover phase; it moves to next quarter",
	baseRevision: 4,
	diff: ['- t4: "flip the flag" removed (was pending)', "- phase p3 \"Cutover\" removed"],
	proposedDocument: "# Tasks\n\n<!-- pi-tasks:v1 {} -->\n",
};

test("the review screen offers exactly accept, request changes, and cancel", () => {
	const screen = taskReviewScreen(SUMMARY);
	assert.deepEqual(
		screen.items.map((item) => item.id),
		["accept", "feedback", "proposed", "cancel"],
	);
	// The three decisions are real actions; "proposed" only navigates.
	assert.equal(screen.items.find((item) => item.id === "accept")?.action, "accept");
	assert.equal(screen.items.find((item) => item.id === "cancel")?.action, "cancel");
	assert.equal(screen.items.find((item) => item.id === "feedback")?.to, "feedback");
	assert.match(screen.lines?.join("\n") ?? "", /drop the cutover phase/u);
	assert.match(screen.lines?.join("\n") ?? "", /2 changes against revision 4/u);
});

test("the proposed document is shown as the document, not as a summary of it", () => {
	const screen = proposedDocumentScreen(SUMMARY);
	assert.equal(screen.content, SUMMARY.proposedDocument);
	assert.deepEqual(screen.format, { kind: "code", language: "markdown" });
});

test("the tasks menu hides what does not apply and disables archiving open work", () => {
	const empty = tasksMenuScreen({
		statusText: "No task set is attached to this session.",
		hasSet: false,
		hasPendingReview: false,
		needsRecovery: false,
		openTasks: 0,
	});
	assert.deepEqual(
		empty.items.map((item) => item.id),
		["new", "close"],
	);

	const busy = tasksMenuScreen({
		statusText: "…",
		documentPath: "/tmp/tasks.md",
		hasSet: true,
		hasPendingReview: true,
		needsRecovery: true,
		openTasks: 3,
	});
	assert.deepEqual(
		busy.items.map((item) => item.id),
		["show", "review", "recover", "export", "archive", "new", "close"],
	);
	const archive = busy.items.find((item) => item.id === "archive");
	assert.equal(archive?.disabled, true);
	assert.match(archive?.description ?? "", /3 task\(s\) are still open/u);

	const closed = tasksMenuScreen({
		statusText: "…",
		hasSet: true,
		hasPendingReview: false,
		needsRecovery: false,
		openTasks: 0,
	});
	assert.equal(closed.items.find((item) => item.id === "archive")?.disabled, false);
	assert.equal(closed.items.some((item) => item.id === "review"), false);
});

test("recovery offers only the options its situation actually has", () => {
	const both = recoveryScreen({
		reason: "the document was modified outside this package",
		documentRevision: 5,
		recordedRevision: 4,
		snapshotRevision: 4,
	});
	assert.deepEqual(
		both.items.map((item) => item.id),
		["attach", "fork", "detach"],
	);
	assert.match(both.lines?.join("\n") ?? "", /revision 5/u);

	const gone = recoveryScreen({ reason: "the task document is gone", snapshotRevision: 4 });
	assert.deepEqual(
		gone.items.map((item) => item.id),
		["fork", "detach"],
	);
	// Nothing here silently rewrites the file: the fork makes a new set.
	assert.match(gone.items[0]?.description ?? "", /new task set/u);
});

test("no menu can change a task; the tools own that", () => {
	const screens = [
		taskReviewScreen(SUMMARY),
		tasksMenuScreen({
			statusText: "…",
			hasSet: true,
			hasPendingReview: true,
			needsRecovery: true,
			openTasks: 0,
		}),
		recoveryScreen({ reason: "x", documentRevision: 1, snapshotRevision: 1 }),
	];
	const labels = screens.flatMap((screen) => screen.items.map((item) => item.label.toLowerCase()));
	for (const forbidden of ["add task", "edit task", "mark done", "revise"]) {
		assert.equal(labels.includes(forbidden), false, forbidden);
	}
});

test("the review menu resolves to a decision through the real menu runtime", async () => {
	for (const [choice, expected] of [
		["Accept revision", { kind: "accepted" }],
		["Cancel revision", { kind: "cancelled" }],
	] as const) {
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			select: async (_title: string, options: string[]) =>
				options.find((option) => option.startsWith(choice)),
		});
		const outcome = await showTaskReviewMenu(context.ctx, { summary: SUMMARY });
		assert.deepEqual(outcome, expected, choice);
	}
});

test("closing the review without choosing is not an approval", async () => {
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		select: async () => undefined,
	});
	assert.deepEqual(await showTaskReviewMenu(context.ctx, { summary: SUMMARY }), {
		kind: "dismissed",
	});
});

test("a mode that cannot render a menu reports unavailable rather than deciding", async () => {
	const context = createMockContext({ mode: "print", hasUI: false });
	assert.deepEqual(await showTaskReviewMenu(context.ctx, { summary: SUMMARY }), {
		kind: "unavailable",
	});
});
