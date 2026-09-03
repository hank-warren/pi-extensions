import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import statsExtension, { includeInMemorySession } from "../index.ts";
import { makeIndex } from "../stats.ts";
import type { UsageRecord } from "../types.ts";

function registeredCommand() {
	let name = "";
	let definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
	statsExtension({
		registerCommand(commandName: string, commandDefinition: unknown) {
			name = commandName;
			definition = commandDefinition as typeof definition;
		},
	} as unknown as ExtensionAPI);
	assert.ok(definition);
	return { name, definition };
}

test("registers /stats and rejects non-interactive invocation without scanning", async () => {
	const { name, definition } = registeredCommand();
	assert.equal(name, "stats");
	const notifications: Array<[string, string]> = [];
	await definition.handler("", {
		mode: "print",
		ui: {
			notify(message: string, level: string) {
				notifications.push([message, level]);
			},
		},
	} as unknown as ExtensionCommandContext);
	assert.deepEqual(notifications, [["/stats requires interactive TUI mode", "warning"]]);
});

function diagnostics() {
	return { discoveredFiles: 1, parsedFiles: 1, reusedFiles: 0, ignoredFiles: 0, unreadableFiles: 0, malformedLines: 0 };
}

function sidecarRecord(): UsageRecord {
	return {
		fingerprint: "sidecar-guardian-1",
		timestamp: Date.parse("2026-08-01T03:00:00.000Z"),
		model: "anthropic/claude-fable-5 (guardian)",
		usage: { input: 100, output: 20, cacheRead: 400, cacheWrite: 30, reasoning: 5, cost: 0.25, calls: 1 },
		kind: "sidecar",
	};
}

function ctxStub(): ExtensionCommandContext {
	return {
		cwd: "/repo",
		sessionManager: {
			getSessionId: () => "session-live",
			getSessionFile: () => undefined,
			getHeader: () => ({ timestamp: "2026-08-01T04:00:00.000Z" }),
			getEntries: () => [
				{
					type: "message",
					id: "live-1",
					timestamp: "2026-08-01T04:05:00.000Z",
					message: {
						role: "assistant",
						provider: "anthropic",
						model: "claude-fable-5",
						content: [{ type: "text", text: "live response" }],
						usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: { total: 0.01 } },
						timestamp: Date.parse("2026-08-01T04:05:00.000Z"),
					},
				},
			],
		},
	} as unknown as ExtensionCommandContext;
}

test("folding the in-memory session into the index keeps sidecar usage", () => {
	const sidecar = sidecarRecord();
	const scanned = makeIndex([], diagnostics(), [sidecar]);
	assert.deepEqual(scanned.usage, [sidecar]);

	const merged = includeInMemorySession(scanned, ctxStub());

	assert.equal(merged.sessions.length, 1, "the in-memory session joins the index");
	assert.equal(merged.sessions[0]!.sessionId, "session-live");
	assert.deepEqual(
		merged.usage.filter((record) => record.kind === "sidecar"),
		[sidecar],
		"sidecar usage survives the rebuild",
	);
	assert.equal(merged.usage.filter((record) => record.kind === "assistant").length, 1, "live session usage is still counted");
	assert.deepEqual(merged.diagnostics, diagnostics());
});

test("an already-scanned session is returned untouched", () => {
	const scanned = makeIndex(
		[
			{
				path: "/sessions/session-live.jsonl",
				sessionId: "session-live",
				cwd: "/repo",
				createdAt: Date.parse("2026-08-01T04:00:00.000Z"),
				lastActivityAt: Date.parse("2026-08-01T04:05:00.000Z"),
				source: "main",
				usage: [],
				toolCalls: [],
			},
		],
		diagnostics(),
		[sidecarRecord()],
	);

	assert.equal(includeInMemorySession(scanned, ctxStub()), scanned);
});
