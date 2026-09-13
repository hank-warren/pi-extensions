// Adapted from Can Celik's MIT-licensed pi-codex-compaction 0.1.5 test suite.
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { model, userEntry, extensionHarness, compactionSse } from "./support/harness.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { needsLegacyCompactionFallback } from "../index.ts";
import {
	buildReplacementHistory,
	effectiveInputForBranch,
	findNativeCheckpoint,
	mergeFeatureHeader,
	NATIVE_COMPACTION_KIND,
	NATIVE_COMPACTION_VERSION,
	retainRecentUserMessages,
	type JsonObject,
} from "../native-compaction.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("pi-codex-compaction", () => {
	test("runs native compaction and never replays the local marker", async () => {
		let requestBody: JsonObject | undefined;
		let requestHeaders: Headers | undefined;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			requestBody = JSON.parse(String(init?.body));
			requestHeaders = new Headers(init?.headers);
			return compactionSse();
		}) as typeof fetch;

		const firstUser = userEntry("user-1", "Remember BLUE-42.");
		const harness = extensionHarness([firstUser]);
		const compact = harness.handlers.get("session_before_compact")!;
		const result = await compact({
			branchEntries: [firstUser],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		assert.equal(result.cancel, undefined);
		assert.ok((result.compaction.summary).includes("OpenAI Codex native compaction checkpoint"));
		assert.deepEqual(result.compaction.details.kind, NATIVE_COMPACTION_KIND);
		assert.deepEqual(result.compaction.details.replacementHistory.at(-1), {
			type: "compaction",
			id: "cmp_1",
			encrypted_content: "opaque-state",
		});
		assert.deepEqual((requestBody!.input as JsonObject[]).at(-1), { type: "compaction_trigger" });
		assert.ok(!(JSON.stringify(requestBody)).includes("checkpoint"));
		assert.ok(requestHeaders!.get("x-codex-beta-features")?.includes("remote_compaction_v2"));
		assert.deepEqual(harness.getBranch().slice(1).map((entry: any) => entry.data?.state), [
			"running",
			"complete",
		]);

		const compactionEntry = {
			type: "compaction",
			id: "compact-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			summary: result.compaction.summary,
			firstKeptEntryId: "user-1",
			tokensBefore: 50_000,
			details: result.compaction.details,
		} as SessionEntry;
		const nextUser = {
			...userEntry("user-2", "What was the code?"),
			parentId: "compact-1",
		} as SessionEntry;
		harness.setBranch([firstUser, compactionEntry, nextUser]);

		const beforeRequest = harness.handlers.get("before_provider_request")!;
		const markerPayload = {
			model: model.id,
			input: [{ role: "user", content: [{ type: "input_text", text: result.compaction.summary }] }],
		};
		const patched = await beforeRequest({ payload: markerPayload }, harness.context);
		const serialized = JSON.stringify(patched);
		assert.ok(!(serialized).includes(result.compaction.summary));
		assert.deepEqual(patched.input[0], {
			role: "user",
			content: [{ type: "input_text", text: "Remember BLUE-42." }],
		});
		assert.deepEqual(patched.input[1], { type: "compaction", id: "cmp_1", encrypted_content: "opaque-state" });
		assert.partialDeepStrictEqual(patched.input[2], { role: "user" });

		const filteredContext = harness.handlers.get("context")!({
			messages: [
				{ role: "compactionSummary", summary: result.compaction.summary },
				{ role: "user", content: [{ type: "text", text: "What was the code?" }] },
			],
		}, harness.context);
		assert.equal((filteredContext.messages).length, 1);
		assert.deepEqual(filteredContext.messages[0].role, "user");
	});

	test("cancels Pi compaction instead of falling back to text summarization", async () => {
		globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
		const entry = userEntry("user-1", "hello");
		const harness = extensionHarness([entry]);
		const result = await harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		assert.deepEqual(result, { cancel: true });
		assert.ok((harness.notifications[0]).includes("native compaction failed"));
		assert.deepEqual(harness.getBranch().slice(1).map((entry: any) => entry.data?.state), [
			"running",
			"failed",
		]);
	});

	test("retries a message-less compaction stream error", async () => {
		let attempts = 0;
		globalThis.fetch = (async () => {
			attempts++;
			if (attempts === 1) {
				return new Response(`data: ${JSON.stringify({ type: "error" })}\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return compactionSse("retried-opaque");
		}) as typeof fetch;
		const entry = userEntry("user-1", "continue after a transient compaction failure");
		const harness = extensionHarness([entry]);
		const result = await harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		assert.deepEqual(attempts, 2);
		assert.deepEqual(result.compaction.details.replacementHistory.at(-1), {
			type: "compaction",
			id: "cmp_1",
			encrypted_content: "retried-opaque",
		});
		assert.deepEqual(harness.getBranch()
			.filter((entry: any) => entry.customType === "openai-codex-compaction-status")
			.map((entry: any) => entry.data.state), ["running", "complete"]);
	});

	test("does not retry an explicit compaction stream error", async () => {
		let attempts = 0;
		globalThis.fetch = (async () => {
			attempts++;
			return new Response(`data: ${JSON.stringify({ type: "error", message: "explicit failure" })}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;
		const entry = userEntry("user-1", "do not retry a permanent compaction failure");
		const harness = extensionHarness([entry]);
		const result = await harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		assert.deepEqual(attempts, 1);
		assert.deepEqual(result, { cancel: true });
		assert.ok((harness.notifications).includes("OpenAI Codex native compaction failed: explicit failure"));
	});

	test("shows the running marker while Pi compaction is in progress", async () => {
		let resolveFetch: ((response: Response) => void) | undefined;
		globalThis.fetch = (() => new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		})) as typeof fetch;
		const entry = userEntry("user-1", "continue the task");
		const harness = extensionHarness([entry]);
		const pending = harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
		}, harness.context);

		assert.deepEqual((harness.getBranch().at(-1) as any).data.state, "running");
		await Promise.resolve();
		assert.notEqual(resolveFetch, undefined);
		resolveFetch!(compactionSse());
		await pending;
		assert.deepEqual((harness.getBranch().at(-1) as any).data.state, "complete");
		const renderer = harness.entryRenderers.get("openai-codex-compaction-status")!;
		const rendered = renderer(
			{ data: { state: "complete" } },
			{},
			{ fg: (_color: string, text: string) => text },
		).render(80).join("\n");
		assert.ok((rendered).includes("OpenAI compaction complete"));
	});

	test("does not compact or abort inside the provider request hook", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return compactionSse();
		}) as typeof fetch;
		const entry = userEntry("user-1", "continue the tool-driven task");
		const harness = extensionHarness([entry]);
		const result = await harness.handlers.get("before_provider_request")!({
			payload: {
				model: model.id,
				input: [{ role: "user", content: [{ type: "input_text", text: "continue the tool-driven task" }] }],
			},
		}, harness.context);

		assert.equal(result, undefined);
		assert.deepEqual(called, false);
		assert.deepEqual(harness.aborted, false);
		assert.deepEqual(harness.getBranch(), [entry]);
	});

	test("enables the compatibility path only before Pi 0.84.4", () => {
		assert.deepEqual(needsLegacyCompactionFallback("0.84.3"), true);
		assert.deepEqual(needsLegacyCompactionFallback("v0.83.0"), true);
		assert.deepEqual(needsLegacyCompactionFallback("0.84.4"), false);
		assert.deepEqual(needsLegacyCompactionFallback("0.85.0"), false);
		assert.deepEqual(needsLegacyCompactionFallback("development"), false);
	});

	test("leaves compaction timing and continuation to current Pi", () => {
		const harness = extensionHarness([userEntry("user-1", "continue the task")], "0.84.4");

		assert.deepEqual(harness.handlers.has("turn_end"), false);
		assert.deepEqual(harness.handlers.has("agent_settled"), false);
		assert.deepEqual(harness.handlers.has("session_compact"), false);
	});

	test("legacy Pi stops before the next provider request, compacts, and resumes", async () => {
		const harness = extensionHarness([userEntry("user-1", "continue the task")], "0.84.3");
		harness.setUsageTokens(180_000);

		harness.handlers.get("turn_end")!({}, harness.context);
		assert.deepEqual(harness.aborted, false);
		await harness.handlers.get("before_provider_request")!({ payload: { model: model.id, input: [] } }, harness.context);
		assert.deepEqual(harness.abortCount, 1);

		harness.setIdle(true);
		harness.handlers.get("agent_settled")!({}, harness.context);
		assert.equal((harness.compactionRequests).length, 1);
		harness.compactionRequests[0].onComplete({});
		assert.deepEqual(harness.sentUserMessages, [{
			content: "Compaction completed. Continue.",
			options: undefined,
		}]);
	});

	test("legacy Pi blocks repeated provider attempts without duplicate warnings", async () => {
		const harness = extensionHarness([userEntry("user-1", "continue the task")], "0.84.3");
		harness.setUsageTokens(180_000);
		harness.handlers.get("turn_end")!({}, harness.context);

		await harness.handlers.get("before_provider_request")!({ payload: { model: model.id, input: [] } }, harness.context);
		await harness.handlers.get("before_provider_request")!({ payload: { model: model.id, input: [] } }, harness.context);

		assert.deepEqual(harness.abortCount, 2);
		assert.deepEqual(harness.notifications, [
			"Stopping before the next OpenAI Codex request to compact context.",
		]);
	});

	test("legacy Pi reuses a native threshold compaction that wins the race", async () => {
		const harness = extensionHarness([userEntry("user-1", "continue the task")], "0.84.3");
		harness.setUsageTokens(180_000);
		harness.handlers.get("turn_end")!({}, harness.context);
		await harness.handlers.get("before_provider_request")!({ payload: { model: model.id, input: [] } }, harness.context);

		harness.handlers.get("session_compact")!({
			reason: "threshold",
			willRetry: false,
			fromExtension: true,
			compactionEntry: { details: { kind: NATIVE_COMPACTION_KIND } },
		}, harness.context);
		harness.setIdle(true);
		harness.handlers.get("agent_settled")!({}, harness.context);

		assert.equal((harness.compactionRequests).length, 0);
		assert.deepEqual(harness.sentUserMessages, [{
			content: "Compaction completed. Continue.",
			options: undefined,
		}]);
	});

	test("legacy Pi defers continuation to overflow recovery", async () => {
		const harness = extensionHarness([userEntry("user-1", "continue the task")], "0.84.3");
		harness.setUsageTokens(180_000);
		harness.handlers.get("turn_end")!({}, harness.context);
		await harness.handlers.get("before_provider_request")!({ payload: { model: model.id, input: [] } }, harness.context);

		harness.handlers.get("session_compact")!({
			reason: "overflow",
			willRetry: true,
			fromExtension: true,
			compactionEntry: { details: { kind: NATIVE_COMPACTION_KIND } },
		}, harness.context);
		harness.setIdle(true);
		harness.handlers.get("agent_settled")!({}, harness.context);

		assert.equal((harness.compactionRequests).length, 0);
		assert.deepEqual(harness.sentUserMessages, []);
	});

	test("legacy Pi compacts silently when the run ends naturally", () => {
		const harness = extensionHarness([userEntry("user-1", "finish the task")], "0.84.3");
		harness.setUsageTokens(180_000);
		harness.handlers.get("turn_end")!({}, harness.context);

		harness.setIdle(true);
		harness.handlers.get("agent_settled")!({}, harness.context);
		assert.equal((harness.compactionRequests).length, 1);
		harness.compactionRequests[0].onComplete({});
		assert.deepEqual(harness.sentUserMessages, []);
	});

	test("legacy Pi does not resume over queued input", async () => {
		const harness = extensionHarness([userEntry("user-1", "continue the task")], "0.84.3");
		harness.setUsageTokens(180_000);
		harness.handlers.get("turn_end")!({}, harness.context);
		await harness.handlers.get("before_provider_request")!({ payload: { model: model.id, input: [] } }, harness.context);
		harness.setIdle(true);
		harness.handlers.get("agent_settled")!({}, harness.context);
		harness.setHasPendingMessages(true);
		harness.compactionRequests[0].onComplete({});
		assert.deepEqual(harness.sentUserMessages, []);
	});

	test("legacy Pi stays idle below its compatibility threshold", () => {
		const harness = extensionHarness([userEntry("user-1", "continue the task")], "0.84.3");
		harness.setUsageTokens(179_999);
		harness.handlers.get("turn_end")!({}, harness.context);
		harness.handlers.get("agent_settled")!({}, harness.context);

		assert.deepEqual(harness.aborted, false);
		assert.equal((harness.compactionRequests).length, 0);
	});

	test("leaves non-Codex providers untouched", async () => {
		const entry = userEntry("user-1", "hello");
		const harness = extensionHarness([entry]);
		const otherContext = {
			...harness.context,
			model: { ...model, provider: "anthropic", api: "anthropic-messages" },
		};

		assert.equal(await harness.handlers.get("before_provider_request")!({ payload: { input: ["original"] } }, otherContext), undefined);
		assert.equal(await harness.handlers.get("session_before_compact")!({
			branchEntries: [entry],
			preparation: { firstKeptEntryId: "user-1", tokensBefore: 50_000 },
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		}, otherContext), undefined);
	});

	test("aborts rather than sending a malformed local checkpoint", async () => {
		const firstUser = userEntry("user-1", "hello");
		const malformed = {
			type: "compaction",
			id: "compact-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			summary: "local marker",
			firstKeptEntryId: "user-1",
			tokensBefore: 100,
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				modelKey: "bad",
				replacementHistory: [],
			},
		} as SessionEntry;
		const harness = extensionHarness([firstUser, malformed]);
		const patched = await harness.handlers.get("before_provider_request")!({
			payload: { model: model.id, input: [{ role: "user", content: "local marker" }] },
		}, harness.context);

		assert.deepEqual(harness.aborted, true);
		assert.deepEqual(patched.input, []);
		assert.ok(!(JSON.stringify(patched)).includes("local marker"));
	});
});

describe("native compaction helpers", () => {
	test("drops foreign reasoning state and response item ids", () => {
		const user = userEntry("user-1", "review this change");
		const assistant = {
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				provider: "xai",
				api: "openai-responses",
				model: "grok-4.6",
				stopReason: "toolUse",
				timestamp: Date.now(),
				content: [
					{
						type: "thinking",
						thinking: "checking",
						thinkingSignature: JSON.stringify({
							type: "reasoning",
							id: "rs_grok_1",
							status: "completed",
							summary: [{ type: "summary_text", text: "checking" }],
							encrypted_content: "opaque-grok-state",
						}),
					},
					{
						type: "text",
						text: "Looks good.",
						textSignature: JSON.stringify({ v: 1, id: "msg_grok_1" }),
					},
					{
						type: "toolCall",
						id: "call_grok_1|fc_grok_1",
						name: "bash",
						arguments: { command: "git status" },
					},
				],
			},
		} as SessionEntry;

		const input = effectiveInputForBranch({ branch: [user, assistant], model, tools: [] });
		const assistantMessage = input.find(
			(item) => item.type === "message" && item.role === "assistant",
		)!;
		const functionCall = input.find((item) => item.type === "function_call")!;

		assert.equal(input.find((item) => item.type === "reasoning"), undefined);
		assert.ok(!(JSON.stringify(input)).includes("opaque-grok-state"));
		assert.equal(assistantMessage.status, undefined);
		assert.deepEqual(assistantMessage.id, "msg_pi_1");
		assert.deepEqual(functionCall.call_id, "call_grok_1");
		assert.equal(functionCall.id, undefined);
	});

	test("removes response-only status from Codex reasoning", () => {
		const user = userEntry("user-1", "continue");
		const assistant = {
			type: "message",
			id: "assistant-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: model.id,
				stopReason: "stop",
				timestamp: Date.now(),
				content: [{
					type: "thinking",
					thinking: "checking",
					thinkingSignature: JSON.stringify({
						type: "reasoning",
						id: "rs_codex_1",
						status: "completed",
						summary: [],
						encrypted_content: "opaque-codex-state",
					}),
				}],
			},
		} as SessionEntry;

		const input = effectiveInputForBranch({ branch: [user, assistant], model, tools: [] });
		const reasoning = input.find((item) => item.type === "reasoning")!;
		assert.equal(reasoning.status, undefined);
		assert.deepEqual(reasoning.encrypted_content, "opaque-codex-state");
	});

	test("retains only recent user messages before the opaque item", () => {
		const input = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "old" }] },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "reply" }] },
			{ type: "function_call", call_id: "call-1" },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "new" }] },
		] as any;
		const retained = retainRecentUserMessages(input);
		assert.equal((retained).length, 2);
		assert.deepEqual(retained.every((item) => item.role === "user"), true);

		const replacement = buildReplacementHistory(input, { type: "compaction", encrypted_content: "opaque" });
		assert.deepEqual(replacement.at(-1), { type: "compaction", encrypted_content: "opaque" });
	});

	test("repeated compaction replaces rather than nests the old opaque item", () => {
		const firstUser = userEntry("user-1", "old user fact");
		const firstCheckpoint = {
			type: "compaction",
			id: "compact-1",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			summary: "local marker 1",
			firstKeptEntryId: "user-1",
			tokensBefore: 100,
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				modelKey: "openai-codex:openai-codex-responses:gpt-test",
				replacementHistory: [
					{ role: "user", content: [{ type: "input_text", text: "old user fact" }] },
					{ type: "compaction", encrypted_content: "opaque-1" },
				],
			},
		} as SessionEntry;
		const nextUser = { ...userEntry("user-2", "new user fact"), parentId: "compact-1" } as SessionEntry;
		const input = effectiveInputForBranch({
			branch: [firstUser, firstCheckpoint, nextUser],
			model,
			tools: [],
		});
		assert.equal((input.filter((item) => item.type === "compaction")).length, 1);

		const replacement = buildReplacementHistory(input, {
			type: "compaction",
			encrypted_content: "opaque-2",
		});
		assert.deepEqual(replacement.filter((item) => item.type === "compaction"), [
			{ type: "compaction", encrypted_content: "opaque-2" },
		]);
		assert.ok((JSON.stringify(replacement)).includes("new user fact"));
	});

	test("overflow recovery excludes the failed assistant response", () => {
		const user = userEntry("user-1", "large request");
		const failure = {
			type: "message",
			id: "assistant-error",
			parentId: "user-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "context window exceeded" }],
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: model.id,
				stopReason: "error",
				timestamp: Date.now(),
			},
		} as SessionEntry;
		const input = effectiveInputForBranch({
			branch: [user, failure],
			model,
			tools: [],
			excludeLastAssistantError: true,
		});
		assert.ok(!(JSON.stringify(input)).includes("context window exceeded"));
		assert.ok((JSON.stringify(input)).includes("large request"));
	});

	test("does not replay partial tool calls from an aborted assistant after a checkpoint", () => {
		const checkpoint = {
			type: "custom",
			id: "checkpoint",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: NATIVE_COMPACTION_KIND,
			data: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				modelKey: "openai-codex:openai-codex-responses:gpt-test",
				replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
			},
		} as SessionEntry;
		const aborted = {
			type: "message",
			id: "assistant-aborted",
			parentId: "checkpoint",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{
					type: "toolCall",
					id: "call-aborted|fc_aborted",
					name: "edit",
					arguments: { path: "src/client/input.rs" },
				}],
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "aborted",
				timestamp: Date.now(),
			},
		} as SessionEntry;
		const user = { ...userEntry("user-after-abort", "what happened?"), parentId: "assistant-aborted" } as SessionEntry;

		const input = effectiveInputForBranch({ branch: [checkpoint, aborted, user], model, tools: [] });
		assert.ok(!(JSON.stringify(input)).includes("call-aborted"));
		assert.ok((JSON.stringify(input)).includes("what happened?"));
	});

	test("synthesizes outputs for non-aborted orphaned tool calls", () => {
		const assistant = {
			type: "message",
			id: "assistant-tool",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-orphan|fc_orphan", name: "edit", arguments: {} }],
				provider: "openai-codex",
				api: "openai-codex-responses",
				model: model.id,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		} as SessionEntry;
		const user = { ...userEntry("user-after-tool", "interrupt"), parentId: "assistant-tool" } as SessionEntry;

		const input = effectiveInputForBranch({ branch: [assistant, user], model, tools: [] });
		assert.ok((input).some((item) => isDeepStrictEqual(item, {
			type: "function_call_output",
			call_id: "call-orphan",
			output: "No result provided",
		})));
	});

	test("latest compaction on the active branch is authoritative", () => {
		const native = {
			type: "compaction",
			id: "native",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "marker",
			firstKeptEntryId: "user",
			tokensBefore: 100,
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				modelKey: "openai-codex:openai-codex-responses:gpt-test",
				replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
			},
		} as SessionEntry;
		assert.deepEqual(findNativeCheckpoint([native]).status, "valid");
		assert.deepEqual(findNativeCheckpoint([native, { ...native, id: "local", details: {} } as SessionEntry]).status, "none");
	});

	test("merges the beta feature without removing existing features", () => {
		assert.deepEqual(mergeFeatureHeader("foo, remote_compaction_v2"), "foo,remote_compaction_v2");
	});
});
