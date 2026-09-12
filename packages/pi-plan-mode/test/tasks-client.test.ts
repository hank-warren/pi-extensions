import assert from "node:assert/strict";
import test from "node:test";
import { createTasksClient } from "../src/tasks-client.js";
import { TASK_REQUEST, TASK_RESPONSE, type TasksRequest } from "../src/plan-contract.js";
import { createMockContext, createMockPi } from "../../../test/support/mock-pi.js";
function setup(timeout = 30) {
	const mock = createMockPi(); const ctx = createMockContext().ctx;
	let subscriptions = 0;
	const on = mock.rawPi.events.on;
	mock.rawPi.events.on = (name, fn) => {
		if (name === TASK_RESPONSE) subscriptions++;
		const off = on(name, fn);
		return () => { if (name === TASK_RESPONSE) subscriptions--; off(); };
	};
	return { mock, ctx, client: createTasksClient(mock.pi, timeout), subscriptions: () => subscriptions };
}
test("reply subscription precedes emit; wrong identities and duplicates cannot satisfy a request", async () => {
	const h = setup();
	h.mock.eventBus.on(TASK_REQUEST, (data) => {
		const r = data as TasksRequest;
		assert.equal(h.subscriptions(), 1);
		for (const patch of [{ requestId: "wrong" }, { sessionId: "wrong" }, {}, {}]) h.mock.eventBus.emit(TASK_RESPONSE, { ...r, ...patch, data: { version: 1 } });
	});
	assert.deepEqual(await h.client.request(h.ctx, { operation: "describe" }), { version: 1 });
	assert.equal(h.subscriptions(), 0);
});
test("timeout, abort and shutdown reject and clean their response subscriptions", async () => {
	const h = setup(5);
	await assert.rejects(h.client.request(h.ctx, { operation: "describe" }), /timed out/u);
	assert.equal(h.subscriptions(), 0);
	const signal = new AbortController();
	const p = h.client.request(h.ctx, { operation: "describe" }, signal.signal);
	const rejected = assert.rejects(p, /cancelled/u); signal.abort(); await rejected;
	assert.equal(h.subscriptions(), 0);
	const q = h.client.request(h.ctx, { operation: "describe" });
	const closed = assert.rejects(q, /cancelled/u); h.client.close(); await closed;
	assert.equal(h.subscriptions(), 0);
});
test("incompatible and malformed responses are errors, not absent or completed tasks", async () => {
	for (const response of [{ version: 2, data: { version: 1 } }, { version: 1, data: { version: 1, set: { phases: [] } } }]) {
		const h = setup();
		h.mock.eventBus.on(TASK_REQUEST, (data) => h.mock.eventBus.emit(TASK_RESPONSE, { ...(data as TasksRequest), ...response }));
		await assert.rejects(h.client.request(h.ctx, { operation: "describe" }), /incompatible|invalid/u);
		assert.equal(h.subscriptions(), 0);
	}
});
