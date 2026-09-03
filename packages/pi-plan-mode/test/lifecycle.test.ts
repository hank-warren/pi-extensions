import assert from "node:assert/strict";
import test from "node:test";
import { createLifecycle } from "../src/lifecycle.js";

test("a menu scope goes stale when either generation moves", () => {
	const lifecycle = createLifecycle();

	const beforeWorkflow = lifecycle.capture();
	assert.equal(beforeWorkflow.isCurrent(), true);
	lifecycle.nextWorkflow();
	assert.equal(beforeWorkflow.isCurrent(), false, "entering or leaving a plan supersedes a menu");

	const beforeSession = lifecycle.capture();
	assert.equal(beforeSession.isCurrent(), true);
	lifecycle.nextSession("Plan-mode session replaced");
	assert.equal(beforeSession.isCurrent(), false, "a replaced session supersedes a menu");
});

/**
 * The settings reload belongs to the session, not to a plan: a hand-edit made
 * while the user happens to be in Plan mode must still apply.
 */
test("a session scope survives workflow changes and ends with the session", () => {
	const lifecycle = createLifecycle();
	const session = lifecycle.nextSession("Plan-mode session replaced");

	lifecycle.nextWorkflow();
	lifecycle.nextWorkflow();
	assert.equal(session.isCurrent(), true);

	lifecycle.endSession("Plan-mode session shut down");
	assert.equal(session.isCurrent(), false);
});

test("ending a session aborts the work waiting on it and stays aborted", () => {
	const lifecycle = createLifecycle();
	const menu = lifecycle.capture();
	assert.equal(menu.signal, lifecycle.signal, "a capture races against the live session signal");

	lifecycle.endSession("Plan-mode session shut down");

	assert.equal(menu.signal.aborted, true);
	const reason = menu.signal.reason as DOMException;
	assert.equal(reason.name, "AbortError");
	assert.equal(reason.message, "Plan-mode session shut down");
	// The shutdown window: a menu opened between shutdown and the next session
	// start must refuse to run, so the aborted signal stays in place.
	assert.equal(lifecycle.signal.aborted, true, "no fresh signal until the next session starts");
	const afterShutdown = lifecycle.capture();
	assert.equal(afterShutdown.signal.aborted, true);
	assert.equal(afterShutdown.isCurrent(), false);
});

test("the next session hands out a fresh unaborted signal", () => {
	const lifecycle = createLifecycle();
	const beforeShutdown = lifecycle.capture();
	lifecycle.endSession("Plan-mode session shut down");

	lifecycle.nextSession("Plan-mode session replaced");

	assert.equal(lifecycle.signal.aborted, false);
	assert.notEqual(lifecycle.signal, beforeShutdown.signal);
	const menu = lifecycle.capture();
	assert.equal(menu.isCurrent(), true);
	assert.equal(menu.signal, lifecycle.signal);
	assert.equal(beforeShutdown.isCurrent(), false, "the old session never becomes current again");
});
