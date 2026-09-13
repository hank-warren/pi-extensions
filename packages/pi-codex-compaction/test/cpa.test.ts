import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadCpaProviders, loadLegacyConfig } from "../config.ts";
import {
	buildCpaHeaders, buildCodexHeaders, isNativeCompactionModel, modelKey,
	resolveCpaResponsesUrl, resolveCodexResponsesUrl, callRemoteCompaction,
	parseNativeCompactionDetails, NATIVE_COMPACTION_KIND,
} from "../native-compaction.ts";
import { cpaModel, model, token, userEntry, extensionHarness, compactionSse, compactEvent } from "./support/harness.ts";

const originalFetch = globalThis.fetch;
const configPath = join(getAgentDir(), "pi-codex-compaction.json");
afterEach(() => { globalThis.fetch = originalFetch; rmSync(configPath, { force: true }); });
function configure(value: unknown) {
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(configPath, JSON.stringify(value));
}
function cpaHarness(branch: SessionEntry[]) {
	const h = extensionHarness(branch);
	h.context.model = { ...cpaModel };
	h.context.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "proxy-test-key", headers: { "X-Proxy-Custom": "preserved" } });
	return h;
}
function checkpoint(details: unknown, parentId: string): SessionEntry {
	return { type: "compaction", id: "checkpoint", parentId, timestamp: new Date().toISOString(),
		summary: "local marker", firstKeptEntryId: parentId, tokensBefore: 50_000, details };
}

describe("CPA eligibility and transport", () => {
	test("only opts known CPA Codex families in; direct Codex is unchanged", () => {
		assert.equal(isNativeCompactionModel(model, []), true);
		for (const id of ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-6-astra", "team/gpt-6-astra", "gpt-6.1-test"]) {
			assert.equal(isNativeCompactionModel({ ...cpaModel, id }, ["cpa"]), true, id);
		}
		for (const invalid of [null, {}, { ...cpaModel, provider: "openai" }, { ...cpaModel, api: "openai-completions" },
			{ ...cpaModel, api: "openai-codex-responses" }, ...["claude-opus-5", "gpt-4.1", "gpt-5.60", "gpt-60", "grok-4"].map((id) => ({ ...cpaModel, id }))]) {
			assert.equal(isNativeCompactionModel(invalid, ["cpa"]), false);
		}
		assert.equal(isNativeCompactionModel(cpaModel, []), false);
		assert.equal(isNativeCompactionModel({ ...cpaModel, provider: "my-cpa" }, ["my-cpa"]), true);
	});

	test("normalizes Responses URLs without using the ChatGPT path", () => {
		for (const base of ["https://proxy.example/v1", "https://proxy.example/v1/", "https://proxy.example/v1/responses/"]) {
			assert.equal(resolveCpaResponsesUrl(base), "https://proxy.example/v1/responses");
		}
		assert.equal(resolveCpaResponsesUrl("http://localhost:8317/v1"), "http://localhost:8317/v1/responses");
		for (const base of ["", "not a url", "file:///tmp/file", "https://user:pass@proxy.example/v1", "https://proxy.example/v1?key=secret", "https://proxy.example/#fragment"]) {
			assert.throws(() => resolveCpaResponsesUrl(base));
		}
		assert.equal(resolveCodexResponsesUrl(), "https://chatgpt.com/backend-api/codex/responses");
	});

	test("uses proxy key auth and preserves custom headers without extracting an account id", () => {
		const headers = buildCpaHeaders({ apiKey: "proxy-test-key", sessionId: "test-session", headers: {
			"X-Custom": "preserve", "X-Codex-Beta-Features": "existing", Authorization: "stale", "X-Removed": null,
		} });
		assert.equal(headers.get("authorization"), "Bearer proxy-test-key");
		assert.equal(headers.get("chatgpt-account-id"), null);
		assert.equal(headers.get("x-custom"), "preserve");
		assert.equal(headers.get("x-removed"), null);
		assert.equal(headers.get("x-codex-beta-features"), "existing,remote_compaction_v2");
		assert.equal(headers.get("session-id"), "test-session");
		assert.equal(headers.get("x-client-request-id"), "test-session");
		assert.equal(headers.get("accept"), "text/event-stream");
		assert.equal(buildCodexHeaders({ apiKey: token(), sessionId: "id" }).get("chatgpt-account-id"), "account-123");
		assert.throws(() => buildCodexHeaders({ apiKey: "proxy-test-key", sessionId: "id" }), /extract/);
	});

	test("binds proxy checkpoints to model, provider, API and endpoint while preserving upstream keys", () => {
		assert.equal(modelKey(model), "openai-codex:openai-codex-responses:gpt-test");
		assert.equal(modelKey(cpaModel), modelKey({ ...cpaModel, baseUrl: cpaModel.baseUrl + "/" }));
		for (const changed of [{ id: "gpt-5.6-sol" }, { provider: "other-cpa" }, { baseUrl: "https://other.example/v1" }]) {
			assert.notEqual(modelKey(cpaModel), modelKey({ ...cpaModel, ...changed }));
		}
	});

	test("reads global opt-in and legacy settings from the isolated Pi agent directory", () => {
		assert.deepEqual(loadCpaProviders(), ["cpa"]);
		configure({ cpaProviders: ["my-cpa", "my-cpa", " ", 5], autoCompact: false, thresholdRatio: 0.8 });
		assert.deepEqual(loadCpaProviders(), ["my-cpa"]);
		assert.deepEqual(loadLegacyConfig(process.cwd(), false), { autoCompact: false, thresholdRatio: 0.8 });
		configure({ cpaProviders: [] });
		assert.deepEqual(loadCpaProviders(), []);
	});
});

describe("CPA lifecycle", () => {
	test("compacts via CPA and replays after resume without losing the finalized system prompt", async () => {
		const first = userEntry("first", "Remember a synthetic fact.");
		const h = cpaHarness([first]);
		const calls: Array<{ url: string; body: any; headers: Headers }> = [];
		globalThis.fetch = (async (url, init) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
			return compactionSse("opaque-cpa");
		}) as typeof fetch;
		const result = await h.handlers.get("session_before_compact")!(compactEvent([first]), h.context);
		assert.equal(calls[0].url, "https://proxy.example/v1/responses");
		assert.equal(calls[0].headers.get("authorization"), "Bearer proxy-test-key");
		assert.equal(calls[0].headers.get("chatgpt-account-id"), null);
		assert.equal(calls[0].headers.get("x-proxy-custom"), "preserved");
		assert.equal(calls[0].body.instructions, "You are Codex.");
		assert.deepEqual(calls[0].body.input.at(-1), { type: "compaction_trigger" });
		assert.equal(result.compaction.details.kind, NATIVE_COMPACTION_KIND);
		assert.equal(result.compaction.details.modelKey, modelKey(cpaModel));
		assert.equal(result.compaction.usage.totalTokens, 110);

		// A fresh extension instance must derive replay solely from persisted details.
		const branch = [first, checkpoint(JSON.parse(JSON.stringify(result.compaction.details)), first.id),
			{ ...userEntry("next", "Recall the fact."), parentId: "checkpoint" }];
		const resumed = cpaHarness(branch);
		const prompt = { role: "developer", content: "Finalized system prompt from an earlier payload hook." };
		const replay = await resumed.handlers.get("before_provider_request")!({ payload: {
			input: [prompt, { role: "user", content: "local marker" }], messages: ["stale"], previous_response_id: "stale",
		} }, resumed.context);
		assert.deepEqual(replay.input[0], prompt);
		assert.equal(replay.input.filter((item: any) => item.type === "compaction").length, 1);
		assert.equal(replay.input.at(-1).content[0].text, "Recall the fact.");
		assert.ok(!JSON.stringify(replay).includes("local marker"));
		assert.equal(replay.messages, undefined);
		assert.equal(replay.previous_response_id, undefined);
		const headers = { "X-Codex-Beta-Features": "existing" };
		resumed.handlers.get("before_provider_headers")!({ headers }, resumed.context);
		assert.equal(headers["X-Codex-Beta-Features"], "existing,remote_compaction_v2");

		const repeated = await resumed.handlers.get("session_before_compact")!(compactEvent(branch, "threshold"), resumed.context);
		assert.equal(calls[1].body.input.filter((item: any) => item.type === "compaction").length, 1);
		assert.equal(repeated.compaction.details.replacementHistory.filter((item: any) => item.type === "compaction").length, 1);
	});

	test("rejects foreign model/endpoint checkpoints without fetching or replaying opaque data", async () => {
		globalThis.fetch = (async () => { throw new Error("Unexpected request"); }) as typeof fetch;
		for (const changed of [{ id: "gpt-5.6-sol" }, { baseUrl: "https://other.example/v1" }]) {
			const first = userEntry("first", "hello");
			const branch = [first, checkpoint({ kind: NATIVE_COMPACTION_KIND, version: 1, modelKey: modelKey(cpaModel),
				replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }] }, first.id)];
			const h = cpaHarness(branch);
			h.context.model = { ...cpaModel, ...changed };
			const replay = await h.handlers.get("before_provider_request")!({ payload: { input: ["marker"] } }, h.context);
			assert.equal(h.aborted, true);
			assert.deepEqual(replay.input, []);
			assert.deepEqual(await h.handlers.get("session_before_compact")!(compactEvent(branch), h.context), { cancel: true });
		}
	});

	test("leaves unsupported CPA models and disabled providers to normal Pi compaction", async () => {
		globalThis.fetch = (async () => { throw new Error("Unexpected request"); }) as typeof fetch;
		const first = userEntry("first", "hello");
		for (const configured of [false, true]) {
			if (configured) configure({ cpaProviders: [] });
			const h = cpaHarness([first]);
			if (!configured) h.context.model = { ...cpaModel, id: "claude-opus-5", api: "anthropic-messages" };
			const headers = {};
			h.handlers.get("before_provider_headers")!({ headers }, h.context);
			assert.deepEqual(headers, {});
			assert.equal(await h.handlers.get("before_provider_request")!({ payload: { input: [] } }, h.context), undefined);
			assert.equal(await h.handlers.get("session_before_compact")!(compactEvent([first]), h.context), undefined);
		}
	});

	test("proxy failures cancel compaction without mutating the previous checkpoint", async () => {
		const first = userEntry("first", "hello");
		const h = cpaHarness([first]);
		globalThis.fetch = (async () => new Response("unsupported", { status: 400 })) as typeof fetch;
		assert.deepEqual(await h.handlers.get("session_before_compact")!(compactEvent([first]), h.context), { cancel: true });
		assert.equal(h.getBranch().filter((entry) => entry.type === "compaction").length, 0);
		assert.ok(h.notifications.some((text) => text.includes("native compaction failed")));
	});

	test("an already-aborted compaction cannot send a request", async () => {
		let calls = 0;
		const signal = AbortSignal.abort();
		await assert.rejects(callRemoteCompaction({ url: "https://proxy.example/v1/responses", headers: new Headers(),
			body: {}, model: cpaModel, signal, fetchImpl: (async () => { calls++; return compactionSse(); }) as typeof fetch }));
		assert.equal(calls, 0);
	});

	test("legacy Pi also guards CPA and resumes only once", async () => {
		const h = extensionHarness([userEntry("first", "continue")], "0.84.0");
		h.context.model = cpaModel;
		h.setUsageTokens(190_000);
		h.handlers.get("turn_end")!({}, h.context);
		await h.handlers.get("before_provider_request")!({ payload: { input: [] } }, h.context);
		assert.equal(h.aborted, true);
		h.setIdle(true);
		h.handlers.get("agent_settled")!({}, h.context);
		assert.equal(h.compactionRequests.length, 1);
		h.compactionRequests[0].onComplete({});
		h.compactionRequests[0].onComplete({});
		assert.equal(h.sentUserMessages.length, 1);
	});

	test("missing proxy authentication cancels without making a request", async () => {
		const first = userEntry("first", "hello");
		const h = cpaHarness([first]);
		h.context.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "auth unavailable" });
		let calls = 0;
		globalThis.fetch = (async () => { calls++; return compactionSse(); }) as typeof fetch;
		assert.deepEqual(await h.handlers.get("session_before_compact")!(compactEvent([first]), h.context), { cancel: true });
		assert.equal(calls, 0);
	});

	test("an ordinary response without a native item cannot become a checkpoint", async () => {
		const first = userEntry("first", "hello");
		const h = cpaHarness([first]);
		globalThis.fetch = (async () => new Response('data: {"type":"response.completed","response":{}}\n\n')) as typeof fetch;
		assert.deepEqual(await h.handlers.get("session_before_compact")!(compactEvent([first]), h.context), { cancel: true });
		assert.ok(h.notifications.some((text) => text.includes("0 compaction items")));
	});

	test("rejects malformed and duplicate checkpoints", () => {
		const details = { kind: NATIVE_COMPACTION_KIND, version: 1, modelKey: modelKey(cpaModel),
			replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }] };
		assert.ok(parseNativeCompactionDetails(details));
		assert.equal(parseNativeCompactionDetails({ ...details, replacementHistory: [...details.replacementHistory, ...details.replacementHistory] }), undefined);
		assert.equal(parseNativeCompactionDetails({ ...details, replacementHistory: [{ type: "compaction" }] }), undefined);
	});
});
