/**
 * `/tasks`: routing, completions, and the review path that has no tool call
 * waiting for its answer.
 *
 * The command is inspection and recovery only. There is no subcommand that
 * edits a task, and the completion list is where that would first show up.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { completeTasksArguments, parseTasksCommand } from "../src/command.js";
import { listProposals } from "../src/proposals.js";
import { callTool, createTasksHarness, SEED_INIT } from "./support/harness.js";

const FIRST_SET = "00000000-0000-4000-8000-000000000001";

test("the subcommands are inspection, management and recovery — never editing", () => {
	assert.deepEqual(
		(completeTasksArguments("") ?? []).map((item) => item.value),
		["show", "review", "new", "archive", "export", "recover"],
	);
	assert.deepEqual(
		(completeTasksArguments("re") ?? []).map((item) => item.value),
		["review", "recover"],
	);
	assert.equal(completeTasksArguments("zzz"), null);
	assert.equal(completeTasksArguments("export ./a.md"), null);
});

test("the parser reads each subcommand, and does not guess at an unknown one", () => {
	assert.deepEqual(parseTasksCommand(""), { kind: "menu" });
	assert.deepEqual(parseTasksCommand("  show "), { kind: "show" });
	assert.deepEqual(parseTasksCommand("REVIEW"), { kind: "review" });
	assert.deepEqual(parseTasksCommand("export"), { kind: "export" });
	assert.deepEqual(parseTasksCommand("export ./out.md"), { kind: "export", path: "./out.md" });
	assert.deepEqual(parseTasksCommand("done t1"), { kind: "unknown", input: "done t1" });
});

async function seeded(options: Parameters<typeof createTasksHarness>[0] = {}) {
	const harness = createTasksHarness(options);
	await harness.emit("session_start", { reason: "startup" });
	await callTool(harness, "update_tasks", { mode: "apply", changes: [SEED_INIT] });
	return harness;
}

function run(harness: Awaited<ReturnType<typeof seeded>>, args: string) {
	const command = harness.commands.get("tasks");
	assert.ok(command);
	return command.handler(args, harness.ctx) as Promise<void>;
}

test("/tasks show puts the list in the transcript, not in the model's context", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	await run(harness, "show");
	const card = harness.cards.at(-1);
	assert.equal(card?.title, "Tasks — migration");
	assert.match(card?.body ?? "", /`t1` add the revision column/u);
});

test("/tasks with an unknown subcommand says what there is, and changes nothing", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	await run(harness, "done t1");
	assert.match(harness.notifications.at(-1)?.message ?? "", /Unknown \/tasks subcommand: done t1/u);
	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.revision, 1);
});

test("/tasks review reopens a pending proposal and can accept it", async (t) => {
	const harness = await seeded({ reviews: [{ kind: "dismissed" }, { kind: "accepted" }] });
	t.after(harness.cleanup);
	const proposed = await callTool(harness, "update_tasks", {
		mode: "propose",
		reason: "drop the cutover phase",
		changes: [{ op: "remove_task", taskId: "t4" }],
	});
	assert.equal(proposed.payload.status, "pending_review");

	await run(harness, "review");
	assert.equal(harness.reviewRequests.length, 2);
	assert.match(harness.notifications.at(-1)?.message ?? "", /revision 2 accepted/u);
	const read = await callTool(harness, "get_tasks", {});
	assert.equal(read.payload.revision, 2);
	assert.deepEqual(read.payload.pendingProposals, []);
});

test("feedback given from /tasks review reaches the agent, because no tool call is waiting", async (t) => {
	const harness = await seeded({
		reviews: [{ kind: "dismissed" }, { kind: "changes_requested", feedback: "keep phase 3" }],
	});
	t.after(harness.cleanup);
	await callTool(harness, "update_tasks", {
		mode: "propose",
		reason: "drop the cutover phase",
		changes: [{ op: "remove_task", taskId: "t4" }],
	});
	await run(harness, "review");

	const sent = harness.sentMessages.at(-1);
	assert.match(String((sent?.message as { content?: string })?.content), /keep phase 3/u);
	assert.match(String((sent?.message as { content?: string })?.content), /mode "propose"/u);
	assert.deepEqual(sent?.options, { deliverAs: "followUp", triggerTurn: true });
	// The proposal is still pending: feedback is not a decision.
	assert.deepEqual(
		(await listProposals(harness.root, FIRST_SET)).map((entry) => entry.status),
		["pending"],
	);
});

test("/tasks review with nothing pending says so", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	await run(harness, "review");
	assert.match(harness.notifications.at(-1)?.message ?? "", /No proposed task revision/u);
	assert.deepEqual(harness.reviewRequests, []);
});

test("/tasks recover is a no-op when the document and the session agree", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	await run(harness, "recover");
	assert.match(harness.notifications.at(-1)?.message ?? "", /nothing to recover/u);
	assert.deepEqual(harness.recoveryMenuCalls, []);
});

test("/tasks export without a path asks for one instead of guessing", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	await run(harness, "export");
	assert.match(harness.notifications.at(-1)?.message ?? "", /Give a path/u);
});

test("bare /tasks opens the menu in a TUI and degrades to a sentence without one", async (t) => {
	const harness = await seeded();
	t.after(harness.cleanup);
	await run(harness, "");
	assert.equal(harness.tasksMenuCalls.length, 1);

	const headless = await seeded({ mode: "print" });
	t.after(headless.cleanup);
	await run(headless, "");
	assert.deepEqual(headless.tasksMenuCalls, []);
	assert.match(headless.notifications.at(-1)?.message ?? "", /at revision 1/u);
});
