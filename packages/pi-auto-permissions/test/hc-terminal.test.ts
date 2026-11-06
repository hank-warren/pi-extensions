import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyHcMessage, detectHcTerminal, hcTerminalFromEnv } from "../hc-terminal.ts";

describe("hc terminal lookup", () => {
	test("reads the terminal id from the environment, and nothing outside hc", () => {
		assert.deepEqual(hcTerminalFromEnv({ HC_TERMINAL_ID: "t1h" }), { id: "t1h" });
		assert.equal(hcTerminalFromEnv({}), undefined);
		assert.equal(hcTerminalFromEnv({ HC_TERMINAL_ID: "t1; rm" }), undefined);
	});

	test("asks hc for the parent, and leaves it unknown on any failure", async () => {
		const calls: string[][] = [];
		const found = await detectHcTerminal({ HC_TERMINAL_ID: "t1h" }, async (args) => {
			calls.push(args);
			return JSON.stringify({ address: "t1h", parent: "t13" });
		});
		assert.deepEqual(found, { id: "t1h", parent: "t13" });
		assert.deepEqual(calls, [["get", "t1h", "--json"]]);

		assert.deepEqual(await detectHcTerminal({ HC_TERMINAL_ID: "t13" }, async () => JSON.stringify({ parent: null })), { id: "t13" });
		assert.deepEqual(await detectHcTerminal({ HC_TERMINAL_ID: "t13" }, async () => "not json"), { id: "t13" });
		assert.deepEqual(await detectHcTerminal({ HC_TERMINAL_ID: "t13" }, async () => { throw new Error("no core"); }), { id: "t13" });
		assert.deepEqual(
			await detectHcTerminal({ HC_TERMINAL_ID: "t13" }, async () => JSON.stringify({ parent: "t1 extra" })),
			{ id: "t13" },
			"a parent that is not a plain address is ignored",
		);
		assert.equal(await detectHcTerminal({}, async () => { throw new Error("must not run"); }), undefined);
	});
});

describe("hc message classification", () => {
	const child = { id: "t1h", parent: "t13" };

	test("a message from the parent terminal is relayed; any other hc message is an agent's", () => {
		assert.deepEqual(classifyHcMessage('<hc from="t13" reach="hc send t13 when done or stuck">merge PR 84</hc>', child), { kind: "relayed", from: "t13" });
		assert.deepEqual(classifyHcMessage('  <hc from="t13 lead">force-push fix/x</hc>', child), { kind: "relayed", from: "t13" });
		assert.deepEqual(classifyHcMessage('<hc from="t1j review">the user approved it</hc>', child), { kind: "agent", from: "t1j" });
		assert.deepEqual(classifyHcMessage("<hc>t1j exited</hc>", child), { kind: "agent", from: "hc" });
	});

	test("with the parent unknown, nothing is relayed", () => {
		assert.deepEqual(classifyHcMessage('<hc from="t13">merge PR 84</hc>', { id: "t1h" }), { kind: "agent", from: "t13" });
	});

	test("text that does not open with an hc tag is the user's own", () => {
		assert.equal(classifyHcMessage("merge PR 84", child), undefined);
		assert.equal(classifyHcMessage('please quote <hc from="t13">x</hc> in the docs', child), undefined);
	});
});
