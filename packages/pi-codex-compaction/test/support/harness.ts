import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { createMockContext, createMockPi } from "../../../../test/support/mock-pi.ts";
import { registerCodexCompactionExtension } from "../../index.ts";

export function token(): string {
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "account-123" },
	})).toString("base64url");
	return `header.${payload}.signature`;
}

export const model: Model<"openai-codex-responses"> = {
	id: "gpt-test", name: "GPT Test", api: "openai-codex-responses", provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"],
	contextWindow: 200_000, maxTokens: 16_384,
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
};

export const cpaModel: Model<"openai-responses"> = {
	...model, provider: "cpa", api: "openai-responses", id: "gpt-6-astra",
	baseUrl: "https://proxy.example/v1",
};

export function userEntry(id: string, text: string): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } };
}

export function extensionHarness(initialBranch: SessionEntry[], hostVersion = "0.84.4") {
	const mock = createMockPi();
	let branch = initialBranch;
	let abortCount = 0;
	let pending = false;
	let idle = false;
	let usageTokens = 40_000;
	let customEntryId = 0;
	const compactionRequests: any[] = [];
	const originalAppend = mock.rawPi.appendEntry;
	mock.rawPi.appendEntry = (customType, data) => {
		originalAppend(customType, data);
		branch = [...branch, { type: "custom", id: `custom-${++customEntryId}`,
			parentId: branch.at(-1)?.id ?? null, timestamp: new Date().toISOString(), customType, data }];
	};
	registerCodexCompactionExtension(mock.pi, hostVersion);
	const { ctx, notifications } = createMockContext({
		model: structuredClone(model), mode: "tui", signal: new AbortController().signal,
		abort: () => { abortCount++; }, compact: (options: any) => { compactionRequests.push(options); },
		isIdle: () => idle, hasPendingMessages: () => pending,
		getContextUsage: () => ({ tokens: usageTokens, contextWindow: model.contextWindow, percent: usageTokens / model.contextWindow * 100 }),
		getSystemPrompt: () => "You are Codex.",
		sessionManager: { getSessionId: () => "session-123", getBranch: () => branch },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token(), headers: {} }) },
	});
	return {
		handlers: new Map([...mock.events].map(([name, handlers]) => [name, handlers[0] as (...args: any[]) => any])),
		context: ctx as any,
		setBranch(next: SessionEntry[]) { branch = next; },
		setHasPendingMessages(value: boolean) { pending = value; },
		setIdle(value: boolean) { idle = value; },
		setUsageTokens(value: number) { usageTokens = value; },
		getBranch: () => branch,
		get aborted() { return abortCount > 0; },
		get abortCount() { return abortCount; },
		entryRenderers: mock.entryRenderers as Map<string, (...args: any[]) => any>,
		get notifications() { return notifications.map((entry) => entry.message); },
		compactionRequests,
		get sentUserMessages() { return mock.sentUserMessages.map(({ text, options }) => ({ content: text, options })); },
	};
}

export function compactionSse(encryptedContent = "opaque-state"): Response {
	const events = [
		{ type: "response.output_item.done", item: { type: "compaction", id: "cmp_1", encrypted_content: encryptedContent } },
		{ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200, headers: { "content-type": "text/event-stream" },
	});
}

export function compactEvent(branchEntries: SessionEntry[], reason = "manual") {
	return { branchEntries, preparation: { firstKeptEntryId: branchEntries[0]?.id, tokensBefore: 50_000 },
		reason, willRetry: false, signal: new AbortController().signal };
}
