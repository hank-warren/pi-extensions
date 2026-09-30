/**
 * The Pi behaviour early sibling reviews depend on, pinned against a real
 * `AgentSession` rather than the mock `ExtensionAPI` the other suites use.
 *
 * `index.ts` starts the reviews of later bash calls from the first call's
 * `tool_call` handler, because Pi runs one assistant message's `tool_call`
 * handlers one at a time. That only works if `message_end` reaches the
 * extension before any of those handlers run, and if the handlers really are
 * sequential. A mock cannot tell us either; this test fails if Pi changes them.
 *
 * One faux provider serves both the agent and the guardian. The agent issues
 * two guarded `echo` commands in one message; the first guardian call is held
 * until the second arrives, which can only happen if the second review started
 * while Pi was still inside the first call's handler.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Context,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import autoPermissionsExtension from "../index.ts";

const PROVIDER = "ap-contract";
const MODEL_ID = "agent";
const OVERLAP_TIMEOUT_MS = 3000;

function isReviewerRequest(context: Context): boolean {
	return (context.systemPrompt ?? "").includes("<LATEST_PROPOSED_ACTION>")
		|| context.messages.some((message) =>
			Array.isArray(message.content)
			&& message.content.some((part) => part.type === "text" && part.text.includes("<LATEST_PROPOSED_ACTION>")));
}

test("Pi delivers message_end before the tool_call handlers it then runs one at a time, so sibling reviews overlap", async () => {
	const previousConfig = process.env.PI_AUTO_PERMISSIONS_CONFIG;
	const dir = mkdtempSync(join(tmpdir(), "pi-ap-contract-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-ap-contract-cwd-"));
	const configPath = join(dir, "config.json");
	writeFileSync(configPath, JSON.stringify({
		reviewer: { provider: PROVIDER, model: MODEL_ID, timeoutMs: 30_000 },
		rules: [{ pattern: "^echo contract", level: "guarded", group: "contract", label: "Contract echo" }],
		usageLog: { enabled: false },
		denialLog: { enabled: false },
	}));
	process.env.PI_AUTO_PERMISSIONS_CONFIG = configPath;

	const core = createFauxCore({ provider: PROVIDER, models: [{ id: MODEL_ID, contextWindow: 200_000, maxTokens: 4096 }] });
	let secondReviewArrived: (() => void) | undefined;
	const secondReview = new Promise<void>((resolve) => {
		secondReviewArrived = resolve;
	});
	let overlapped = false;
	const reviewedCommands: string[] = [];
	const approve = (context: Context) => {
		const text = JSON.stringify(context.messages.at(-1)?.content ?? "");
		reviewedCommands.push(text.includes("contract-a") ? "a" : text.includes("contract-b") ? "b" : "?");
		return fauxAssistantMessage(fauxText(JSON.stringify({ decision: "approve", reason: "contract test" })));
	};
	const reviewer = (hold: boolean): FauxResponseStep => async (context) => {
		assert.ok(isReviewerRequest(context), "the guardian call arrives where the script expects it");
		if (hold) {
			overlapped = await Promise.race([
				secondReview.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), OVERLAP_TIMEOUT_MS).unref()),
			]);
		} else {
			secondReviewArrived?.();
		}
		return approve(context);
	};
	core.setResponses([
		fauxAssistantMessage([
			fauxToolCall("bash", { command: "echo contract-a" }, { id: "call-a" }),
			fauxToolCall("bash", { command: "echo contract-b" }, { id: "call-b" }),
		], { stopReason: "toolUse" }),
		reviewer(true),
		reviewer(false),
		fauxAssistantMessage("done"),
	]);

	const registerFaux = (pi: ExtensionAPI) => {
		pi.registerProvider(PROVIDER, {
			api: core.api,
			// Required for custom models; the faux stream never makes a request.
			baseUrl: "http://127.0.0.1:9",
			apiKey: "contract-test",
			streamSimple: core.streamSimple,
			models: [{
				id: MODEL_ID,
				name: "Contract agent",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 4096,
			}],
		});
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		extensionFactories: [registerFaux, autoPermissionsExtension],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		model: core.getModel(),
	});
	const toolResults: Array<{ id: string; isError: boolean; text: string }> = [];
	session.subscribe((event) => {
		if (event.type !== "tool_execution_end") return;
		const text = (event.result?.content ?? [])
			.map((part: { type: string; text?: string }) => (part.type === "text" ? part.text ?? "" : ""))
			.join("");
		toolResults.push({ id: event.toolCallId, isError: event.isError, text });
	});

	try {
		await session.bindExtensions({});
		await session.prompt("run the contract commands");

		assert.equal(overlapped, true, "the second call's review started before the first call's review finished");
		assert.deepEqual([...reviewedCommands].sort(), ["a", "b"], "each guarded command was reviewed exactly once");
		assert.deepEqual(
			toolResults.map((result) => [result.id, result.isError, result.text.trim()]).sort(),
			[["call-a", false, "contract-a"], ["call-b", false, "contract-b"]],
			"both approved commands ran",
		);
		assert.equal(core.getPendingResponseCount(), 0, "no scripted response was left unused");
	} finally {
		session.dispose();
		if (previousConfig === undefined) delete process.env.PI_AUTO_PERMISSIONS_CONFIG;
		else process.env.PI_AUTO_PERMISSIONS_CONFIG = previousConfig;
		rmSync(dir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

/**
 * Codemode arrived in Pi 0.99; the pinned test runtime predates it, so this
 * runs where codemode exists (the nightly drift job, a local latest install)
 * and is skipped elsewhere. Looked up at runtime so the file still typechecks
 * against the pinned version.
 */
const createCodemodeExtension = (PiCodingAgent as Record<string, unknown>).createCodemodeExtension as
	| ((options?: Record<string, unknown>) => (pi: ExtensionAPI) => void)
	| undefined;

test(
	"a bash call a codemode script left behind is released when the script ends, and never runs",
	{ skip: createCodemodeExtension ? false : "this Pi has no codemode" },
	async () => {
		const previousConfig = process.env.PI_AUTO_PERMISSIONS_CONFIG;
		const dir = mkdtempSync(join(tmpdir(), "pi-ap-contract-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-ap-contract-cwd-"));
		const marker = join(cwd, "orphan-ran");
		const configPath = join(dir, "config.json");
		writeFileSync(configPath, JSON.stringify({
			reviewer: { provider: PROVIDER, model: MODEL_ID, timeoutMs: 30_000 },
			rules: [{ pattern: "^echo contract", level: "guarded", group: "contract", label: "Contract echo" }],
			usageLog: { enabled: false },
			denialLog: { enabled: false },
		}));
		process.env.PI_AUTO_PERMISSIONS_CONFIG = configPath;

		const core = createFauxCore({ provider: PROVIDER, models: [{ id: MODEL_ID, contextWindow: 200_000, maxTokens: 4096 }] });
		let scriptEnded = false;
		// The guardian never answers until the test is over: the orphan can only
		// finish if the extension lets go of it when its script ends.
		let releaseReviewer: (() => void) | undefined;
		const reviewerHeld = new Promise<void>((resolve) => {
			releaseReviewer = resolve;
		});
		let agentTurns = 0;
		let reviews = 0;
		// Fires the guarded call without awaiting it, lets it reach review while an
		// unguarded call runs, then ends the script. (Ending it at once would let Pi
		// abort the call before any tool_call hook ran, which proves nothing here.)
		const script = [
			`tools.bash({ command: ${JSON.stringify(`echo contract > ${marker}`)} });`,
			`await tools.bash({ command: "echo unguarded" });`,
			`throw new Error("bail");`,
		].join("\n");
		const respond: FauxResponseStep = async (context) => {
			if (isReviewerRequest(context)) {
				reviews += 1;
				await reviewerHeld;
				return fauxAssistantMessage(fauxText(JSON.stringify({ decision: "approve", reason: "contract test" })));
			}
			agentTurns += 1;
			return agentTurns === 1
				? fauxAssistantMessage(fauxToolCall("codemode", { code: script }, { id: "script-1" }), { stopReason: "toolUse" })
				: fauxAssistantMessage("done");
		};
		core.setResponses([respond, respond, respond, respond]);

		const registerFaux = (pi: ExtensionAPI) => {
			pi.registerProvider(PROVIDER, {
				api: core.api,
				baseUrl: "http://127.0.0.1:9",
				apiKey: "contract-test",
				streamSimple: core.streamSimple,
				models: [{
					id: MODEL_ID,
					name: "Contract agent",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 4096,
				}],
			});
		};
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			extensionFactories: [registerFaux, createCodemodeExtension!(), autoPermissionsExtension],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			model: core.getModel(),
			tools: ["codemode", "bash"],
		});
		const orphanResults: string[] = [];
		let orphanId: string | undefined;
		session.subscribe((event) => {
			const parent = (event as { parentToolCallId?: string }).parentToolCallId;
			if (event.type === "tool_execution_start" && parent === "script-1") {
				if ((event.args as { command?: string } | undefined)?.command?.startsWith("echo contract")) orphanId = event.toolCallId;
				return;
			}
			if (event.type !== "tool_execution_end") return;
			if (!parent && event.toolCallId === "script-1") scriptEnded = true;
			if (event.toolCallId === orphanId) {
				orphanResults.push((event.result?.content ?? [])
					.map((part: { type: string; text?: string }) => (part.type === "text" ? part.text ?? "" : ""))
					.join(""));
			}
		});

		try {
			await session.bindExtensions({});
			await session.prompt("run the contract script");
			// The orphan finishes on its own schedule, after the turn that abandoned it.
			const deadline = Date.now() + OVERLAP_TIMEOUT_MS;
			while (orphanResults.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));

			assert.equal(scriptEnded, true);
			assert.equal(reviews, 1, "the orphan was under review when its script ended");
			// Pi reports its own abort for a call whose signal is already aborted,
			// whatever the hook returned; what matters is that the hook let go.
			assert.deepEqual(orphanResults, ["Operation aborted"], "the orphan finished while its review was still unanswered");
			assert.equal(existsSync(marker), false, "the abandoned command never ran");
		} finally {
			releaseReviewer?.();
			session.dispose();
			if (previousConfig === undefined) delete process.env.PI_AUTO_PERMISSIONS_CONFIG;
			else process.env.PI_AUTO_PERMISSIONS_CONFIG = previousConfig;
			rmSync(dir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);
