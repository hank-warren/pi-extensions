import assert from "node:assert/strict";
import { appendFile, chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { isExternalSessionDirectory, resolveSessionRoots, scanStats, statsCachePath } from "../cache.ts";

function sessionText(secret = "TOP SECRET PROMPT"): string {
	return [
		JSON.stringify({ type: "session", version: 3, id: "session", timestamp: "2026-08-01T00:00:00.000Z", cwd: "/private/repo" }),
		JSON.stringify({ type: "message", id: "user", parentId: null, timestamp: "2026-08-01T00:00:01.000Z", message: { role: "user", content: secret } }),
		JSON.stringify({
			type: "message",
			id: "assistant",
			parentId: "user",
			timestamp: "2026-08-01T00:00:02.000Z",
			message: {
				role: "assistant",
				provider: "openai-codex",
				model: "gpt",
				content: [{ type: "text", text: "SECRET RESPONSE" }],
				usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 1, totalTokens: 10, cost: { total: 0.1 } },
			},
		}),
	].join("\n") + "\n";
}

async function fixture(): Promise<{ base: string; agentDir: string; sessions: string; file: string }> {
	const base = await mkdtemp(join(tmpdir(), "pi-stats-"));
	const agentDir = join(base, "agent");
	const sessions = join(agentDir, "sessions");
	await mkdir(sessions, { recursive: true });
	const file = join(sessions, "session.jsonl");
	await writeFile(file, sessionText(), "utf8");
	return { base, agentDir, sessions, file };
}

test("builds one private content-free cache and reuses unchanged files", async (t) => {
	const data = await fixture();
	t.after(() => rm(data.base, { recursive: true, force: true }));
	const first = await scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions] });
	assert.equal(first.sessions.length, 1);
	assert.equal(first.diagnostics.parsedFiles, 1);
	const path = statsCachePath(data.agentDir);
	const cached = await readFile(path, "utf8");
	assert.doesNotMatch(cached, /TOP SECRET PROMPT|SECRET RESPONSE/);
	const mode = (await import("node:fs/promises")).stat(path).then((value) => value.mode & 0o777);
	assert.equal(await mode, 0o600);

	const second = await scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions] });
	assert.equal(second.diagnostics.reusedFiles, 1);
	assert.equal(second.diagnostics.parsedFiles, 0);
});

test("reparses growing files and removes deleted files from the cache", async (t) => {
	const data = await fixture();
	t.after(() => rm(data.base, { recursive: true, force: true }));
	await scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions] });
	await appendFile(
		data.file,
		`${JSON.stringify({ type: "compaction", id: "new", parentId: "assistant", timestamp: "2026-08-01T00:00:03.000Z", usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0 } } })}\n`,
	);
	const grown = await scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions] });
	assert.equal(grown.diagnostics.parsedFiles, 1);
	assert.equal(grown.usage.length, 2);

	await unlink(data.file);
	const deleted = await scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions] });
	assert.equal(deleted.sessions.length, 0);
	const cache = JSON.parse(await readFile(statsCachePath(data.agentDir), "utf8")) as { files: object };
	assert.equal(Object.keys(cache.files).length, 0);
});

test("recovers from corrupt and old-schema caches", async (t) => {
	const data = await fixture();
	t.after(() => rm(data.base, { recursive: true, force: true }));
	const path = statsCachePath(data.agentDir);
	await mkdir(join(data.agentDir, "pi-stats"), { recursive: true });
	await writeFile(path, "not json", "utf8");
	assert.equal((await scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions] })).diagnostics.parsedFiles, 1);
	await writeFile(path, JSON.stringify({ version: 999, files: {} }), "utf8");
	assert.equal((await scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions] })).diagnostics.parsedFiles, 1);
	await writeFile(path, JSON.stringify({ version: 1, files: { [data.file]: { size: "bad" } } }), "utf8");
	assert.equal((await scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions] })).diagnostics.parsedFiles, 1);
});

test("skips symlinks and non-session JSONL artifacts", async (t) => {
	const data = await fixture();
	t.after(() => rm(data.base, { recursive: true, force: true }));
	await writeFile(join(data.sessions, "events.jsonl"), `${JSON.stringify({ event: "stream" })}\n`, "utf8");
	const artifacts = join(data.sessions, "subagent-artifacts");
	await mkdir(artifacts);
	await writeFile(join(artifacts, "looks-like-session.jsonl"), sessionText(), "utf8");
	await symlink(data.file, join(data.sessions, "linked.jsonl"));
	const index = await scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions], force: true });
	assert.equal(index.sessions.length, 1);
	assert.equal(index.diagnostics.discoveredFiles, 2);
	assert.equal(index.diagnostics.ignoredFiles, 1);
});

test("atomic concurrent writers leave one valid cache and no temporary files", async (t) => {
	const data = await fixture();
	t.after(() => rm(data.base, { recursive: true, force: true }));
	await Promise.all([
		scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions], force: true }),
		scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions], force: true }),
	]);
	const parsed = JSON.parse(await readFile(statsCachePath(data.agentDir), "utf8")) as { version: number };
	assert.equal(parsed.version, 3);
	assert.deepEqual((await readdir(join(data.agentDir, "pi-stats"))).sort(), ["cache.json"]);
});

function sidecarLine(overrides: Record<string, unknown> = {}): string {
	return `${JSON.stringify({
		v: 1,
		id: "11111111-1111-4111-8111-111111111111",
		ts: "2026-08-01T03:00:00.000Z",
		source: "auto-permissions",
		label: "guardian",
		provider: "anthropic",
		model: "claude-fable-5",
		usage: { input: 100, output: 20, cacheRead: 400, cacheWrite: 30, reasoning: 5, cost: 0.25 },
		...overrides,
	})}\n`;
}

test("counts extension usage sidecars without inventing sessions", async (t) => {
	const data = await fixture();
	t.after(() => rm(data.base, { recursive: true, force: true }));
	const sidecarDir = join(data.agentDir, "pi-auto-permissions");
	await mkdir(sidecarDir, { recursive: true });
	const sidecar = join(sidecarDir, "usage.jsonl");
	await writeFile(sidecar, sidecarLine() + sidecarLine({ id: "22222222-2222-4222-8222-222222222222" }), "utf8");
	await writeFile(join(sidecarDir, "usage.jsonl.1"), sidecarLine({ id: "33333333-3333-4333-8333-333333333333" }), "utf8");
	// Neither an unrelated JSONL in the same directory nor a malformed record may be counted.
	await writeFile(join(sidecarDir, "review-evals.jsonl"), `${JSON.stringify({ version: 2, command: "rm -rf /" })}\n`, "utf8");
	await appendFile(sidecar, `${JSON.stringify({ v: 99, usage: { input: 5 } })}\nnot json\n`, "utf8");

	const index = await scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions] });
	const guardian = index.usage.filter((record) => record.kind === "sidecar");
	assert.equal(guardian.length, 3);
	assert.equal(index.sessions.length, 1, "sidecars never create sessions");
	assert.deepEqual(new Set(guardian.map((record) => record.model)), new Set(["anthropic/claude-fable-5 (guardian)"]));
	assert.equal(guardian[0]!.usage.cost, 0.25);
	assert.equal(index.diagnostics.malformedLines, 2);

	const reused = await scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions] });
	assert.equal(reused.diagnostics.parsedFiles, 0);
	assert.equal(reused.usage.filter((record) => record.kind === "sidecar").length, 3);

	const disabled = await scanStats({
		agentDir: data.agentDir,
		sessionRoots: [data.sessions],
		env: { PI_STATS_DISABLE_USAGE_SIDECARS: "1" },
	});
	assert.equal(disabled.usage.filter((record) => record.kind === "sidecar").length, 0);
});

test("discovers configured and extra session roots without duplicates", async (t) => {
	const data = await fixture();
	t.after(() => rm(data.base, { recursive: true, force: true }));
	const extra = join(data.base, "extra");
	await mkdir(extra);
	await writeFile(join(data.agentDir, "settings.json"), JSON.stringify({ subagents: { defaultSessionDir: extra } }), "utf8");
	const roots = await resolveSessionRoots({
		agentDir: data.agentDir,
		activeSessionDir: data.sessions,
		env: {
			PI_CODING_AGENT_SESSION_DIR: extra,
			PI_STATS_SESSION_DIRS: [extra, data.sessions].join(delimiter),
		},
	});
	assert.deepEqual(new Set(roots), new Set([data.sessions, extra]));
	assert.equal(isExternalSessionDirectory(data.sessions, data.agentDir), false);
	assert.equal(isExternalSessionDirectory(extra, data.agentDir), true);
});

test("reports progress, honors cancellation, and removes stale atomic-write files", async (t) => {
	const data = await fixture();
	t.after(() => rm(data.base, { recursive: true, force: true }));
	const cacheDirectory = join(data.agentDir, "pi-stats");
	await mkdir(cacheDirectory, { recursive: true });
	const stale = join(cacheDirectory, "cache.json.123.dead.tmp");
	await writeFile(stale, "partial", "utf8");
	const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
	await utimes(stale, old, old);
	const progress: Array<[number, number]> = [];
	await scanStats({
		agentDir: data.agentDir,
		sessionRoots: [data.sessions],
		onProgress: (completed, total) => progress.push([completed, total]),
	});
	assert.deepEqual(progress.at(-1), [1, 1]);
	assert.deepEqual(await readdir(cacheDirectory), ["cache.json"]);

	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions], force: true, signal: controller.signal }),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
});

test("the scan pool is bounded, ordered, and monotonic in its progress", async () => {
	const { mapConcurrentOrdered } = await import("../cache.ts");
	const items = Array.from({ length: 40 }, (_, index) => index);
	let inFlight = 0;
	let peak = 0;
	const progress: Array<[number, number]> = [];

	const results = await mapConcurrentOrdered(
		items,
		8,
		async (item) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			// Reverse the natural completion order so a pool that reduced by
			// completion instead of discovery index would scramble the output.
			await new Promise((resolve) => setTimeout(resolve, (items.length - item) % 5));
			inFlight -= 1;
			return item * 2;
		},
		(completed, total) => progress.push([completed, total]),
	);

	assert.ok(peak > 1, "the pool actually runs work concurrently");
	assert.ok(peak <= 8, `the pool exceeded its ceiling (peak ${peak})`);
	assert.deepEqual(results, items.map((item) => item * 2), "results keep discovery order");
	assert.deepEqual(
		progress.map(([completed]) => completed),
		items.map((_, index) => index + 1),
		"progress counts up once per completed item",
	);
	assert.deepEqual(progress.at(-1), [40, 40]);
});

test("the scan pool stops handing out work once cancelled", async () => {
	const { mapConcurrentOrdered } = await import("../cache.ts");
	const controller = new AbortController();
	const started: number[] = [];

	await assert.rejects(
		mapConcurrentOrdered(
			Array.from({ length: 30 }, (_, index) => index),
			4,
			async (item) => {
				started.push(item);
				if (item === 3) controller.abort();
				return item;
			},
			undefined,
			controller.signal,
		),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
	assert.ok(started.length < 30, "work stopped being assigned after the abort");
	assert.ok(started.length >= 4, "already-started work was allowed to settle");
});

test("a scan mixing cache hits, fresh parses and unreadable files stays deterministic", async (t) => {
	const data = await fixture();
	t.after(() => rm(data.base, { recursive: true, force: true }));
	for (let index = 0; index < 12; index++) {
		await writeFile(join(data.sessions, `session-${index}.jsonl`), sessionText(), "utf8");
	}
	const first = await scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions] });
	assert.equal(first.diagnostics.parsedFiles, 13);

	// One file changes and one becomes unreadable; everything else is a hit.
	await appendFile(join(data.sessions, "session-0.jsonl"), sessionText(), "utf8");
	const unreadable = join(data.sessions, "session-1.jsonl");
	await appendFile(unreadable, sessionText(), "utf8");
	await chmod(unreadable, 0o000);
	t.after(() => chmod(unreadable, 0o600).catch(() => undefined));

	const second = await scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions] });
	assert.equal(second.diagnostics.unreadableFiles, 1);
	assert.equal(second.diagnostics.parsedFiles, 1);
	assert.equal(second.diagnostics.reusedFiles, 11);

	// A third scan changes nothing: the reparsed file is now a hit, and the
	// unreadable one is still counted exactly once.
	const third = await scanStats({ agentDir: data.agentDir, sessionRoots: [data.sessions] });
	assert.deepEqual(third.diagnostics, {
		...second.diagnostics,
		parsedFiles: 0,
		reusedFiles: 12,
	});
});

test("an aborted scan pool settles every started worker before it rejects", async () => {
	const { mapConcurrentOrdered } = await import("../cache.ts");
	const controller = new AbortController();
	const releases: Array<() => void> = [];
	let settled = 0;
	let progressAfterAbort = 0;

	const pending = mapConcurrentOrdered(
		Array.from({ length: 20 }, (_, index) => index),
		4,
		(item) =>
			new Promise<number>((resolve) => {
				releases.push(() => {
					settled += 1;
					resolve(item);
				});
			}),
		() => {
			if (controller.signal.aborted) progressAfterAbort += 1;
		},
		controller.signal,
	);
	let rejected = false;
	const guarded = pending.catch(() => {
		rejected = true;
	});

	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(releases.length, 4, "the pool filled its slots");
	controller.abort();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(rejected, false, "work in flight is not abandoned mid-read");

	for (const release of releases) release();
	await guarded;
	assert.equal(rejected, true);
	assert.equal(settled, 4, "exactly the started workers ran, and all of them finished");
	assert.equal(progressAfterAbort, 0, "nothing is published after the abort");
});
