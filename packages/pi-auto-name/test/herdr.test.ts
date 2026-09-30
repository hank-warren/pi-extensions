import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support/mock-pi.ts";
import { reportSessionName } from "../herdr.ts";
import autoName from "../index.ts";

type Request = { method: string; params: { pane_id: string; source: string; seq: number; tokens: Record<string, string | null> } };

/** A stand-in Herdr server on a real Unix socket, recording each request. */
async function fakeHerdr(t: test.TestContext, respond = true) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "herdr-"));
	const socketPath = path.join(dir, "herdr.sock");
	const requests: Request[] = [];
	const server = net.createServer((socket) => {
		socket.on("data", (chunk) => {
			for (const line of chunk.toString().split("\n").filter(Boolean)) requests.push(JSON.parse(line));
			if (respond) socket.write('{"id":"x","result":{}}\n');
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "w1:p1" });
	t.after(() => {
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_SOCKET_PATH;
		delete process.env.HERDR_PANE_ID;
		server.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return requests;
}

function setup(mode = "tui") {
	const mock = createMockPi();
	let name: string | undefined;
	Object.assign(mock.rawPi, { getSessionName: () => name, setSessionName: (value: string) => (name = value) });
	autoName(mock.pi);
	const { ctx } = createMockContext({ mode });
	return {
		setName: (value: string | undefined) => (name = value),
		fire: async (event: string, payload: unknown = {}) => {
			for (const handler of mock.events.get(event) ?? []) await handler(payload, ctx);
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("reports the name as the session_name token, and clears it with null", async (t) => {
	const requests = await fakeHerdr(t);
	await reportSessionName("statusline cache fix");
	await reportSessionName(undefined);
	assert.equal(requests.length, 2);
	assert.equal(requests[0].method, "pane.report_metadata");
	assert.deepEqual(
		{ pane: requests[0].params.pane_id, source: requests[0].params.source, tokens: requests[0].params.tokens },
		{ pane: "w1:p1", source: "pi-auto-name", tokens: { session_name: "statusline cache fix" } },
	);
	assert.deepEqual(requests[1].params.tokens, { session_name: null });
	assert.ok(requests[1].params.seq > requests[0].params.seq, "seq increases so stale reports are ignored");
});

test("follows session start, every rename, and clears on quit only", async (t) => {
	const requests = await fakeHerdr(t);
	const s = setup();
	s.setName("resumed name");
	await s.fire("session_start", { reason: "resume" });
	await s.fire("session_info_changed", { name: "renamed" });
	await s.fire("session_shutdown", { reason: "reload" });
	await s.fire("session_shutdown", { reason: "quit" });
	await settle();
	assert.deepEqual(
		requests.map((request) => request.params.tokens.session_name),
		["resumed name", "renamed", null],
	);
});

test("an unnamed session clears any token left by the previous one", async (t) => {
	const requests = await fakeHerdr(t);
	await setup().fire("session_start", { reason: "new" });
	await settle();
	assert.deepEqual(requests.map((request) => request.params.tokens), [{ session_name: null }]);
});

test("sends nothing outside Herdr or outside the TUI", async (t) => {
	const requests = await fakeHerdr(t);
	await setup("print").fire("session_info_changed", { name: "x" });
	delete process.env.HERDR_ENV;
	await reportSessionName("x");
	await settle();
	assert.equal(requests.length, 0);
});

test("never throws or hangs when Herdr is missing or silent", async (t) => {
	await fakeHerdr(t, false);
	const started = Date.now();
	await reportSessionName("silent server");
	assert.ok(Date.now() - started < 2000, "bounded by the timeout");

	process.env.HERDR_SOCKET_PATH = path.join(os.tmpdir(), "no-such-herdr.sock");
	await reportSessionName("missing server");
});
