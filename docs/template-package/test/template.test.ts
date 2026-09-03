import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import templateExtension from "../index.ts";

type RegisteredTool = {
	name: string;
	label: string;
	description: string;
	execute: (
		toolCallId: string,
		params: { name: string },
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

function collectTools(): RegisteredTool[] {
	const tools: RegisteredTool[] = [];
	const pi = {
		registerTool: (tool: RegisteredTool) => {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;
	templateExtension(pi);
	return tools;
}

test("registers exactly the template tool", () => {
	const tools = collectTools();
	assert.equal(tools.length, 1);
	assert.equal(tools[0].name, "template_greet");
	assert.equal(tools[0].label, "Template Greet");
});

test("template tool returns text content", async () => {
	const [tool] = collectTools();
	const result = await tool.execute("call-1", { name: "world" });
	assert.deepEqual(result.content, [{ type: "text", text: "hello, world" }]);
});
