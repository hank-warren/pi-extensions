/**
 * What the extension registers, and what the model is told about it.
 *
 * The tool names and the guidance are the product decision this package exists
 * to make: a request to change the work is a tool call, not an instruction to
 * edit a file or type a command. A guideline that drifts back to "tell the user
 * to run /tasks" would pass every other test in this directory.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { callTool, createTasksHarness, SEED_INIT } from "./support/harness.js";

test("exactly two tools and one command, named as specified", (t) => {
	const harness = createTasksHarness();
	t.after(harness.cleanup);
	assert.deepEqual([...harness.tools.keys()].sort(), ["get_tasks", "update_tasks"]);
	assert.deepEqual([...harness.commands.keys()], ["tasks"]);
	// The names this package must never take: they belong to other trackers and
	// would collide in a session that has one installed.
	assert.equal(harness.tools.has("todo"), false);
	assert.equal(harness.commands.has("todos"), false);
	assert.equal(harness.commands.has("todo"), false);
});

test("update_tasks takes a mode and a batch, and nothing that bypasses review", (t) => {
	const harness = createTasksHarness();
	t.after(harness.cleanup);
	const schema = harness.tools.get("update_tasks")?.parameters as {
		properties: Record<string, unknown>;
		required?: string[];
	};
	assert.deepEqual(Object.keys(schema.properties).sort(), [
		"changes",
		"expectedRevision",
		"mode",
		"reason",
		"taskSetId",
	]);
	assert.deepEqual([...(schema.required ?? [])].sort(), ["changes", "mode"]);
	const mode = schema.properties.mode as { enum?: string[] };
	assert.deepEqual(mode.enum, ["apply", "propose"]);
	// No force, no approve, no skip_review: a model-callable bypass is the one
	// thing that would make the review card decorative.
	for (const forbidden of ["force", "approve", "skipReview", "autoAccept"]) {
		assert.equal(forbidden in schema.properties, false, forbidden);
	}
});

test("get_tasks is read-only: its whole input is an optional id", (t) => {
	const harness = createTasksHarness();
	t.after(harness.cleanup);
	const schema = harness.tools.get("get_tasks")?.parameters as {
		properties: Record<string, unknown>;
		required?: string[];
	};
	assert.deepEqual(Object.keys(schema.properties), ["taskSetId"]);
	assert.deepEqual(schema.required ?? [], []);
});

test("every change op is reachable from the schema", (t) => {
	const harness = createTasksHarness();
	t.after(harness.cleanup);
	const schema = harness.tools.get("update_tasks")?.parameters as {
		properties: { changes: { items: { properties: { op: { enum: string[] } } } } };
	};
	assert.deepEqual(schema.properties.changes.items.properties.op.enum, [
		"init",
		"add_phase",
		"rename_phase",
		"add_task",
		"edit_task",
		"move_task",
		"start",
		"done",
		"block",
		"unblock",
		"abandon",
		"reopen",
		"remove_task",
		"remove_phase",
	]);
});

test("the guidance sends structural change to the tool, never to a file or a command", (t) => {
	const harness = createTasksHarness();
	t.after(harness.cleanup);
	const guidelines = (harness.tools.get("update_tasks")?.promptGuidelines as string[]).join("\n");
	assert.match(guidelines, /never tell the user to edit the task file/u);
	assert.match(guidelines, /never use edit or write on it/u);
	assert.match(guidelines, /mode "propose"/u);
	assert.match(guidelines, /exact id/u);
	// Each bullet names its tool, because Pi appends them flat into one list.
	for (const guideline of harness.tools.get("update_tasks")?.promptGuidelines as string[]) {
		assert.match(guideline, /update_tasks/u, guideline);
	}
	for (const guideline of harness.tools.get("get_tasks")?.promptGuidelines as string[]) {
		assert.match(guideline, /get_tasks/u, guideline);
	}
});

test("both tools carry a prompt snippet, so the model can see them at all", (t) => {
	const harness = createTasksHarness();
	t.after(harness.cleanup);
	for (const name of ["get_tasks", "update_tasks"]) {
		const snippet = harness.tools.get(name)?.promptSnippet;
		assert.equal(typeof snippet, "string", name);
		assert.ok((snippet as string).length > 0, name);
	}
});

test("update_tasks trims the whitespace models put on enum values", async (t) => {
	const harness = createTasksHarness();
	t.after(harness.cleanup);
	await harness.emit("session_start", { reason: "startup" });
	const result = await callTool(harness, "update_tasks", {
		mode: "apply\n",
		changes: [{ ...SEED_INIT, op: " init " }],
	});
	assert.equal(result.isError, false, JSON.stringify(result.payload));
	assert.equal(result.payload.status, "applied");
});

test("the card renderer is registered and survives data it did not write", (t) => {
	const harness = createTasksHarness();
	t.after(harness.cleanup);
	const renderer = harness.entryRenderers.get("pi-tasks-card") as (
		entry: unknown,
		options: unknown,
		theme: unknown,
	) => unknown;
	assert.ok(renderer);
	assert.doesNotThrow(() => renderer({ data: undefined }, { expanded: false }, {}));
	assert.doesNotThrow(() => renderer({ data: { title: "t", body: "b" } }, { expanded: true }, {}));
});
