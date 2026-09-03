import assert from "node:assert/strict";
import test from "node:test";
import { buildSnapshot, deduplicateUsage, makeIndex, parseSessionText } from "../stats.ts";
import { totalTokens, type SessionRecord, type UsageTotals } from "../types.ts";

const usage = (overrides: Record<string, unknown> = {}) => ({
	input: 10,
	output: 5,
	cacheRead: 20,
	cacheWrite: 2,
	reasoning: 3,
	totalTokens: 37,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
	...overrides,
});

const entry = (value: object) => JSON.stringify(value);
const header = (id = "session-a", timestamp = "2026-08-01T00:00:00.000Z") =>
	entry({ type: "session", version: 3, id, timestamp, cwd: "/repo" });

function assistant(id: string, timestamp: string, extra: Record<string, unknown> = {}): string {
	return entry({
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			provider: "openai-codex",
			model: "router",
			responseModel: "gpt-5.6-sol",
			content: [{ type: "text", text: "private response" }],
			usage: usage(),
			timestamp: Date.parse(timestamp),
			...extra,
		},
	});
}

function parsed(path: string, lines: string[]): SessionRecord {
	const result = parseSessionText(path, `${lines.join("\n")}\n`);
	assert.equal(result.ignored, false);
	assert.ok(result.session);
	return result.session;
}

function diagnostics() {
	return { discoveredFiles: 0, parsedFiles: 0, reusedFiles: 0, ignoredFiles: 0, unreadableFiles: 0, malformedLines: 0 };
}

test("parses current and legacy usage without double-counting reasoning", () => {
	const session = parsed("/sessions/main.jsonl", [
		header(),
		assistant("same-short-id", "2026-08-01T01:00:00.000Z"),
		entry({
			type: "message",
			id: "legacy",
			parentId: null,
			timestamp: "2026-08-01T02:00:00.000Z",
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude",
				usage: {
					inputTokens: 4,
					outputTokens: 3,
					cacheReadTokens: 2,
					cacheWriteTokens: 1,
					reasoningTokens: 2,
					costUsd: 0.5,
				},
			},
		}),
	]);
	assert.equal(session.usage.length, 2);
	assert.equal(totalTokens(session.usage[0]!.usage), 37);
	assert.equal(session.usage[0]!.usage.reasoning, 3);
	assert.equal(totalTokens(session.usage[1]!.usage), 10);
	assert.equal(session.usage[1]!.usage.reasoning, 2);
	assert.equal(session.usage[1]!.usage.cost, 0.5);
});

test("attributes response models, nested tool models, and summaries", () => {
	const session = parsed("/sessions/main.jsonl", [
		header(),
		assistant("a", "2026-08-01T01:00:00.000Z"),
		entry({
			type: "message",
			id: "tool",
			parentId: "a",
			timestamp: "2026-08-01T02:00:00.000Z",
			message: { role: "toolResult", toolName: "vault_research", usage: usage(), details: { model: "anthropic/claude-opus-5" } },
		}),
		entry({ type: "compaction", id: "compact", parentId: "tool", timestamp: "2026-08-01T03:00:00.000Z", usage: usage() }),
	]);
	assert.deepEqual(session.usage.map((record) => record.model), [
		"openai-codex/gpt-5.6-sol",
		"anthropic/claude-opus-5",
		"Tools/summaries",
	]);
});

test("rolls usage-free placeholder models into the summary bucket but keeps metered ones", () => {
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { total: 0 } };
	const session = parsed("/sessions/main.jsonl", [
		header(),
		// Pi's own placeholder turn: no tokens, no cost, no real model.
		assistant("synthetic", "2026-08-01T01:00:00.000Z", { provider: "anthropic", model: "<synthetic>", responseModel: undefined, usage: zero }),
		// A missing model normalizes to `unknown` and is unattributable in the same way.
		assistant("unknown", "2026-08-01T02:00:00.000Z", { provider: "", model: "", responseModel: undefined, usage: zero }),
		// A placeholder that actually recorded spend keeps its own row so cost stays visible.
		assistant("metered", "2026-08-01T03:00:00.000Z", { provider: "anthropic", model: "<synthetic>", responseModel: undefined }),
		assistant("real", "2026-08-01T04:00:00.000Z", { usage: zero }),
	]);
	assert.deepEqual(session.usage.map((record) => record.model), [
		"Tools/summaries",
		"Tools/summaries",
		"anthropic/<synthetic>",
		"openai-codex/gpt-5.6-sol",
	]);
	assert.equal(session.usage[0]!.usage.calls, 1);
	assert.equal(totalTokens(session.usage[0]!.usage), 0);
});

test("ignores non-session files and tolerates malformed trailing records", () => {
	assert.equal(parseSessionText("/events.jsonl", `${entry({ event: "delta" })}\n`).ignored, true);
	const result = parseSessionText("/session.jsonl", `${header()}\n{partial`);
	assert.equal(result.ignored, false);
	assert.equal(result.malformedLines, 1);
});

test("deduplicates copied fork history but not deliberate short-id collisions", () => {
	const copied = assistant("deadbeef", "2026-08-01T01:00:00.000Z");
	const first = parsed("/sessions/first.jsonl", [header("first"), copied]);
	const fork = parsed("/sessions/fork.jsonl", [header("fork"), copied]);
	const collision = parsed("/sessions/collision.jsonl", [
		header("collision"),
		assistant("deadbeef", "2026-08-01T01:00:01.000Z", { usage: usage({ input: 11, totalTokens: 38 }) }),
	]);
	const records = deduplicateUsage([first, fork, collision]);
	assert.equal(records.length, 2);
	assert.equal(records.reduce((sum, record) => sum + totalTokens(record.usage), 0), 75);
});

test("prefers persisted child usage over a parent subagent summary", () => {
	const childPath = "/sessions/parent/run-id/run-0/session.jsonl";
	const parent = parsed("/sessions/parent.jsonl", [
		header("parent"),
		entry({
			type: "message",
			id: "subagent-result",
			parentId: null,
			timestamp: "2026-08-01T01:00:00.000Z",
			message: {
				role: "toolResult",
				toolName: "subagent",
				details: {
					totalChildUsage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1 },
					results: [{ sessionFile: childPath }],
				},
			},
		}),
	]);
	const child = parsed(childPath, [header("child"), assistant("child-call", "2026-08-01T02:00:00.000Z")]);
	assert.equal(deduplicateUsage([parent, child]).length, 1);
	assert.equal(totalTokens(deduplicateUsage([parent, child])[0]!.usage), 37);
});

test("uses a subagent parent summary when its persisted child is unavailable", () => {
	const parent = parsed("/sessions/parent.jsonl", [
		header("parent"),
		entry({
			type: "message",
			id: "subagent-result",
			parentId: null,
			timestamp: "2026-08-01T01:00:00.000Z",
			message: {
				role: "toolResult",
				toolName: "subagent",
				details: {
					totalChildUsage: { input: 40, output: 10, cacheRead: 20, cacheWrite: 5, cost: 2 },
					results: [{ sessionFile: "/pruned/session.jsonl" }],
				},
			},
		}),
	]);
	const records = deduplicateUsage([parent]);
	assert.equal(records.length, 1);
	assert.equal(totalTokens(records[0]!.usage), 75);
	assert.equal(records[0]!.usage.cost, 2);
});

test("builds ranged totals, streaks, source counts, and reconciling model totals", () => {
	const dates = ["2026-08-09T12:00:00", "2026-08-10T12:00:00", "2026-08-11T12:00:00"];
	const main = parsed("/sessions/main.jsonl", [header("main", `${dates[0]}Z`), ...dates.map((date, index) => assistant(`m${index}`, `${date}Z`))]);
	const child = parsed("/sessions/run/run-0/session.jsonl", [header("child", `${dates[1]}Z`), assistant("c", `${dates[1]}Z`)]);
	const index = makeIndex([main, child], diagnostics());
	const snapshot = buildSnapshot(index, [], "current", "7d", new Date("2026-08-11T18:00:00").getTime());
	assert.equal(snapshot.sessionCount, 2);
	assert.equal(snapshot.mainSessionCount, 1);
	assert.equal(snapshot.subagentSessionCount, 1);
	assert.equal(snapshot.activeDays, 3);
	assert.equal(snapshot.currentStreak, 3);
	assert.equal(snapshot.longestStreak, 3);
	assert.equal(snapshot.favoriteModel, "openai-codex/gpt-5.6-sol");
	assert.equal(snapshot.models.reduce((sum, model) => sum + model.total, 0), totalTokens(snapshot.period));
	assert.equal(snapshot.longestSessionMs, 2 * 24 * 60 * 60 * 1000);
});

test("counts live current-session entries and hardens missing header timestamps", () => {
	const noTimestampHeader = entry({ type: "session", version: 3, id: "old", cwd: "/repo" });
	const old = parsed("/sessions/old.jsonl", [noTimestampHeader, assistant("old-call", "2026-08-01T01:00:00.000Z")]);
	assert.equal(old.createdAt, Date.parse("2026-08-01T01:00:00.000Z"));
	assert.equal(old.lastActivityAt, old.createdAt);
	const index = makeIndex([old], diagnostics());
	const live = JSON.parse(assistant("live", "2026-08-11T10:00:00.000Z"));
	const current = buildSnapshot(index, [live], "current", "30d", new Date("2026-08-11T18:00:00").getTime());
	assert.equal(totalTokens(current.currentSession), 37);
	assert.equal(totalTokens(current.period), 37);
});

function toolResult(id: string, timestamp: string, toolName: string, extra: Record<string, unknown> = {}): string {
	return entry({
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName,
			content: [{ type: "text", text: "private tool output" }],
			isError: false,
			timestamp: Date.parse(timestamp),
			...extra,
		},
	});
}

test("records tool calls that carry no model usage", () => {
	const session = parsed("/sessions/tools.jsonl", [
		header(),
		toolResult("t1", "2026-08-01T01:00:00.000Z", "bash"),
		toolResult("t2", "2026-08-01T01:01:00.000Z", "read"),
		toolResult("t3", "2026-08-01T01:02:00.000Z", "bash", { isError: true }),
	]);
	// None of these recorded usage, so the usage list stays empty and model attribution is untouched.
	assert.equal(session.usage.length, 0);
	assert.equal(session.toolCalls.length, 3);
	assert.deepEqual(
		session.toolCalls.map((call) => call.toolName),
		["bash", "read", "bash"],
	);
	assert.deepEqual(
		session.toolCalls.map((call) => call.isError),
		[false, false, true],
	);
});

test("normalizes namespaced tool names and defaults a missing name", () => {
	const session = parsed("/sessions/namespaced.jsonl", [
		header(),
		toolResult("t1", "2026-08-01T01:00:00.000Z", "functions.bash"),
		toolResult("t2", "2026-08-01T01:01:00.000Z", "bash"),
		entry({
			type: "message",
			id: "t3",
			timestamp: "2026-08-01T01:02:00.000Z",
			message: { role: "toolResult", toolCallId: "call-t3", content: [], isError: false },
		}),
	]);
	assert.deepEqual(
		session.toolCalls.map((call) => call.toolName),
		["bash", "bash", "tool"],
	);
});

test("deduplicates tool calls copied into a forked session", () => {
	const lines = [toolResult("t1", "2026-08-01T01:00:00.000Z", "bash"), toolResult("t2", "2026-08-01T01:01:00.000Z", "read")];
	const main = parsed("/sessions/main.jsonl", [header("session-a"), ...lines]);
	// A fork copies the entries verbatim under a new session id; the provider tool-call ids repeat.
	const fork = parsed("/sessions/fork.jsonl", [header("session-b"), ...lines, toolResult("t3", "2026-08-01T01:02:00.000Z", "edit")]);
	const index = makeIndex([main, fork], diagnostics());
	assert.equal(index.toolCalls.length, 3, "shared calls are counted once, the fork-only call is kept");
	const snapshot = buildSnapshot(index, [], "current", "all", Date.parse("2026-08-01T05:00:00.000Z"));
	assert.deepEqual(
		snapshot.tools.map((tool) => [tool.toolName, tool.calls]),
		[
			["bash", 1],
			["edit", 1],
			["read", 1],
		],
	);
});

test("aggregates tools by call count with error rate, share, and registry source", () => {
	const session = parsed("/sessions/tools.jsonl", [
		header(),
		toolResult("t1", "2026-08-01T01:00:00.000Z", "bash"),
		toolResult("t2", "2026-08-01T01:01:00.000Z", "bash", { isError: true }),
		toolResult("t3", "2026-08-01T01:02:00.000Z", "bash"),
		toolResult("t4", "2026-08-01T01:03:00.000Z", "web_search"),
	]);
	const index = makeIndex([session], diagnostics());
	const sources = new Map([
		["bash", "builtin"],
		["web_search", "pi-web-search"],
	]);
	const snapshot = buildSnapshot(index, [], "current", "all", Date.parse("2026-08-01T05:00:00.000Z"), "current-session.jsonl", sources);
	assert.deepEqual(snapshot.tools, [
		{ toolName: "bash", source: "builtin", calls: 3, errors: 1, share: 0.75 },
		{ toolName: "web_search", source: "pi-web-search", calls: 1, errors: 0, share: 0.25 },
	]);
});

test("leaves a tool with no live registry entry unlabelled", () => {
	const session = parsed("/sessions/tools.jsonl", [header(), toolResult("t1", "2026-08-01T01:00:00.000Z", "retired_tool")]);
	const index = makeIndex([session], diagnostics());
	const snapshot = buildSnapshot(index, [], "current", "all", Date.parse("2026-08-01T05:00:00.000Z"));
	assert.equal(snapshot.tools.length, 1);
	assert.equal(snapshot.tools[0]!.source, undefined);
});

test("filters tool calls to the selected range", () => {
	const session = parsed("/sessions/tools.jsonl", [
		header("session-a", "2026-07-01T00:00:00.000Z"),
		toolResult("old", "2026-07-01T01:00:00.000Z", "bash"),
		toolResult("recent", "2026-08-11T01:00:00.000Z", "read"),
	]);
	const index = makeIndex([session], diagnostics());
	const now = new Date("2026-08-11T18:00:00").getTime();
	assert.equal(buildSnapshot(index, [], "current", "all", now).tools.length, 2);
	assert.deepEqual(
		buildSnapshot(index, [], "current", "7d", now).tools.map((tool) => tool.toolName),
		["read"],
		"the older call falls outside the 7 day window",
	);
});

test("rolls sessions up by working directory", () => {
	const header2 = (id: string, cwd: string) =>
		entry({ type: "session", version: 3, id, timestamp: "2026-08-11T00:00:00.000Z", cwd });
	const a = parsed("/sessions/a.jsonl", [header2("a", "/repos/alpha"), assistant("a1", "2026-08-11T01:00:00.000Z")]);
	const b = parsed("/sessions/b.jsonl", [header2("b", "/repos/alpha"), assistant("b1", "2026-08-11T02:00:00.000Z")]);
	const c = parsed("/sessions/c.jsonl", [header2("c", "/repos/beta"), assistant("c1", "2026-08-11T03:00:00.000Z")]);
	const index = makeIndex([a, b, c], diagnostics());
	const snapshot = buildSnapshot(index, [], "current", "all", new Date("2026-08-11T18:00:00").getTime());
	assert.deepEqual(
		snapshot.projects.map((project) => [project.label, project.sessions, project.total]),
		[
			["alpha", 2, 74],
			["beta", 1, 37],
		],
	);
	assert.equal(snapshot.projects[0]!.cwd, "/repos/alpha");
	assert.equal(snapshot.projects.reduce((sum, project) => sum + project.share, 0), 1);
});

test("omits sessions with no recorded working directory from the project rollup", () => {
	const noCwd = parsed("/sessions/x.jsonl", [
		entry({ type: "session", version: 3, id: "x", timestamp: "2026-08-11T00:00:00.000Z" }),
		assistant("x1", "2026-08-11T01:00:00.000Z"),
	]);
	const index = makeIndex([noCwd], diagnostics());
	const snapshot = buildSnapshot(index, [], "current", "all", new Date("2026-08-11T18:00:00").getTime());
	assert.deepEqual(snapshot.projects, []);
});

test("project totals never exceed the all-time total they partition", () => {
	const header2 = (id: string, cwd: string) =>
		entry({ type: "session", version: 3, id, timestamp: "2026-08-11T00:00:00.000Z", cwd });
	const lines = [assistant("shared-1", "2026-08-11T01:00:00.000Z"), assistant("shared-2", "2026-08-11T02:00:00.000Z")];
	const main = parsed("/sessions/main.jsonl", [header2("main", "/repos/alpha"), ...lines]);
	// A fork copies the same usage under a new session id, and may sit in a different directory.
	const fork = parsed("/sessions/fork.jsonl", [header2("fork", "/repos/alpha-worktree"), ...lines]);
	const index = makeIndex([main, fork], diagnostics());
	const snapshot = buildSnapshot(index, [], "current", "all", new Date("2026-08-11T18:00:00").getTime());
	const projectTotal = snapshot.projects.reduce((sum, project) => sum + project.total, 0);
	assert.equal(projectTotal, totalTokens(snapshot.allTime), "copied fork usage is attributed once, not to both directories");
	const projectCost = snapshot.projects.reduce((sum, project) => sum + project.cost, 0);
	assert.ok(Math.abs(projectCost - snapshot.allTime.cost) < 1e-9, "cost partitions the same way");
});
