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
 * while Pi was still inside the first call's handler. A guarded call in an
 * earlier turn builds the reviewer lineage first: with none, concurrent
 * reviews wait for one cold build instead of overlapping.
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
		fauxAssistantMessage(fauxToolCall("bash", { command: "echo contract-seed" }, { id: "call-seed" }), { stopReason: "toolUse" }),
		(context) => {
			assert.ok(isReviewerRequest(context), "the seed call is reviewed");
			return fauxAssistantMessage(fauxText(JSON.stringify({ decision: "approve", reason: "seed" })));
		},
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
			[["call-a", false, "contract-a"], ["call-b", false, "contract-b"], ["call-seed", false, "contract-seed"]],
			"every approved command ran",
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

interface CodemodeScenario {
	scriptEnded: boolean;
	/** Guardian requests made; the guardian never answers until the scenario is over. */
	reviews: number;
	/** The text of the last guardian request. */
	reviewRequest: string;
	/** Results of the guarded calls the script fired, in the order they finished. */
	orphanResults: string[];
	/** Whether any guarded command ran. */
	ran: boolean;
	/** tool_call hooks of the script's calls and turn_end, in the order Pi ran them. */
	order: string[];
}

/**
 * Run one assistant turn whose single tool call is a codemode script, with a
 * guardian that never answers while the turn runs. `script` receives a marker
 * path per guarded call; a command that ran creates its marker.
 */
async function runCodemodeScenario(options: {
	guarded: number;
	script: (markers: string[]) => string;
	sequential?: boolean;
}): Promise<CodemodeScenario> {
	const previousConfig = process.env.PI_AUTO_PERMISSIONS_CONFIG;
	const dir = mkdtempSync(join(tmpdir(), "pi-ap-contract-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-ap-contract-cwd-"));
	const markers = Array.from({ length: options.guarded }, (_, index) => join(cwd, `orphan-ran-${index}`));
	const configPath = join(dir, "config.json");
	writeFileSync(configPath, JSON.stringify({
		reviewer: { provider: PROVIDER, model: MODEL_ID, timeoutMs: 30_000 },
		rules: [{ pattern: "^echo contract", level: "guarded", group: "contract", label: "Contract echo" }],
		usageLog: { enabled: false },
		denialLog: { enabled: false },
	}));
	process.env.PI_AUTO_PERMISSIONS_CONFIG = configPath;

	const core = createFauxCore({ provider: PROVIDER, models: [{ id: MODEL_ID, contextWindow: 200_000, maxTokens: 4096 }] });
	const result: CodemodeScenario = { scriptEnded: false, reviews: 0, reviewRequest: "", orphanResults: [], ran: false, order: [] };
	let releaseReviewer: (() => void) | undefined;
	const reviewerHeld = new Promise<void>((resolve) => {
		releaseReviewer = resolve;
	});
	let agentTurns = 0;
	const script = options.script(markers);
	const respond: FauxResponseStep = async (context) => {
		if (isReviewerRequest(context)) {
			result.reviews += 1;
			result.reviewRequest = context.messages
				.flatMap((message) => (Array.isArray(message.content) ? message.content : []) as Array<{ type: string; text?: string }>)
				.map((part) => (part.type === "text" ? part.text ?? "" : ""))
				.join("\n");
			await reviewerHeld;
			return fauxAssistantMessage(fauxText(JSON.stringify({ decision: "approve", reason: "contract test" })));
		}
		agentTurns += 1;
		return agentTurns === 1
			? fauxAssistantMessage(fauxToolCall("codemode", { code: script }, { id: "script-1" }), { stopReason: "toolUse" })
			: fauxAssistantMessage("done");
	};
	core.setResponses(Array.from({ length: options.guarded + 3 }, () => respond));

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
	const recordOrder = (pi: ExtensionAPI) => {
		pi.on("tool_call", (event) => {
			if ((event as { parentToolCallId?: string }).parentToolCallId) result.order.push(`tool_call ${event.toolCallId}`);
		});
		pi.on("turn_end", () => {
			result.order.push("turn_end");
		});
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		extensionFactories: [registerFaux, createCodemodeExtension!(), recordOrder, autoPermissionsExtension],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		model: core.getModel(),
		tools: ["codemode", "bash"],
	});
	if (options.sequential) (session as unknown as { agent: { toolExecution: string } }).agent.toolExecution = "sequential";
	const orphanIds = new Set<string>();
	session.subscribe((event) => {
		const parent = (event as { parentToolCallId?: string }).parentToolCallId;
		if (event.type === "tool_execution_start" && parent === "script-1") {
			if ((event.args as { command?: string } | undefined)?.command?.startsWith("echo contract")) orphanIds.add(event.toolCallId);
			return;
		}
		if (event.type !== "tool_execution_end") return;
		if (!parent && event.toolCallId === "script-1") result.scriptEnded = true;
		if (orphanIds.has(event.toolCallId)) {
			result.orphanResults.push((event.result?.content ?? [])
				.map((part: { type: string; text?: string }) => (part.type === "text" ? part.text ?? "" : ""))
				.join(""));
		}
	});

	try {
		await session.bindExtensions({});
		await session.prompt("run the contract script");
		// Left-behind calls finish on their own schedule, after the turn that abandoned them.
		const deadline = Date.now() + OVERLAP_TIMEOUT_MS;
		while (result.orphanResults.length < options.guarded && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		result.ran = markers.some((marker) => existsSync(marker));
		return result;
	} finally {
		releaseReviewer?.();
		session.dispose();
		if (previousConfig === undefined) delete process.env.PI_AUTO_PERMISSIONS_CONFIG;
		else process.env.PI_AUTO_PERMISSIONS_CONFIG = previousConfig;
		rmSync(dir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
}

const guardedEcho = (marker: string) => `tools.bash({ command: ${JSON.stringify(`echo contract > ${marker}`)} });`;

test(
	"a bash call a codemode script left behind is released when the script ends, and never runs",
	{ skip: createCodemodeExtension ? false : "this Pi has no codemode" },
	async () => {
		// Fires the guarded call without awaiting it, lets it reach review while an
		// unguarded call runs, then ends the script. (Ending it at once would let Pi
		// abort the call before any tool_call hook ran, which proves nothing here.)
		const run = await runCodemodeScenario({
			guarded: 1,
			script: ([marker]) => [guardedEcho(marker), `await tools.bash({ command: "echo unguarded" });`, `throw new Error("bail");`].join("\n"),
		});

		assert.equal(run.scriptEnded, true);
		assert.equal(run.reviews, 1, "the orphan was under review when its script ended");
		// The running script is already in the session when its calls are
		// reviewed, so the guardian sees it and knows which script issued the call.
		assert.ok(run.reviewRequest.includes("SCRIPT codemode [script-1]:"), "the guardian was shown the running script");
		assert.ok(run.reviewRequest.includes("tools.bash({ command: "), "with its source");
		assert.ok(run.reviewRequest.includes('"issuedByScript": "script-1"'), "and the call is linked to it");
		// Pi reports its own abort for a call whose signal is already aborted,
		// whatever the hook returned; what matters is that the hook let go.
		assert.deepEqual(run.orphanResults, ["Operation aborted"], "the orphan finished while its review was still unanswered");
		assert.equal(run.ran, false, "the abandoned command never ran");
	},
);

test(
	"with sequential tool execution, calls a script left behind reach their hook after the turn and are still released",
	{ skip: createCodemodeExtension ? false : "this Pi has no codemode" },
	async () => {
		// Pi queues a script's calls before their hooks when tool execution is
		// sequential, so once the script times out the queued ones reach the hook
		// one by one, some after the turn has ended.
		const guarded = 8;
		const run = await runCodemodeScenario({
			guarded,
			sequential: true,
			script: (markers) => [`// @options: {"timeout_ms": 400}`, ...markers.map(guardedEcho), `await new Promise(() => {});`].join("\n"),
		});

		assert.equal(run.scriptEnded, true);
		const turnEnd = run.order.indexOf("turn_end");
		assert.ok(
			turnEnd >= 0 && run.order.slice(turnEnd).some((entry) => entry.startsWith("tool_call ")),
			`the scenario this pins: a left-behind call reaches its hook after turn_end (${run.order.join(", ")})`,
		);
		assert.equal(run.reviews, 1, "only the call under review when the script ended reached the guardian");
		assert.deepEqual(run.orphanResults, Array.from({ length: guarded }, () => "Operation aborted"));
		assert.equal(run.ran, false);
	},
);
