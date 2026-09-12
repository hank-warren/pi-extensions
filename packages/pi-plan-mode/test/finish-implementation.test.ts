/**
 * The end of implementation, under the conditions a review found it wrong:
 * an archive that takes long enough for the session to move on underneath
 * it, a filesystem that refuses it, a plan replaced while it is in flight, a
 * symlink where a plan should be, and a parent whose child archived the file
 * they shared.
 *
 * `fs.promises.link` is patched through the CJS object and re-synced into
 * the ESM namespace (which is itself frozen) so the archive can be held or
 * failed on demand.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support/mock-pi.js";
import { archivePlanFile, planFilePathForSession, plansDirectory, writePlanFile } from "../src/plan-file.js";
import planMode from "../src/plan-mode.js";

type ToolExecute = (...args: unknown[]) => Promise<unknown>;
type Mock = ReturnType<typeof createMockPi>;
type Context = ReturnType<typeof createMockContext>;

const PRELOAD_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const STATE_ENTRY_TYPE = "plan-mode-state";
const fsp = fs.promises as { link: typeof fs.promises.link };
const realLink = fs.promises.link;

async function withAgentDir<T>(run: () => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-plan-finish-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		return await run();
	} finally {
		process.env.PI_CODING_AGENT_DIR = PRELOAD_AGENT_DIR;
		await rm(directory, { recursive: true, force: true });
	}
}

/** Replace `link` for the duration of `run`, whatever happens inside it. */
async function withLink<T>(replacement: typeof fs.promises.link, run: () => Promise<T>): Promise<T> {
	fsp.link = replacement;
	syncBuiltinESMExports();
	try {
		return await run();
	} finally {
		fsp.link = realLink;
		syncBuiltinESMExports();
	}
}

/** A `link` that waits for `release()` before doing the real thing. */
function heldLink() {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const link: typeof fs.promises.link = async (source, target) => {
		await gate;
		return realLink(source, target);
	};
	return { link, release };
}

function tool(mock: Mock, name: string) {
	const execute = mock.tools.find((candidate) => candidate.name === name)?.execute as ToolExecute | undefined;
	assert.ok(execute, `${name} must be registered`);
	return execute;
}

function selecting(label: string) {
	return createMockContext({
		hasUI: true,
		mode: "tui",
		select: async (_frame: string, options: string[]) => options.find((option) => option.startsWith(label)),
	});
}

async function planAndImplement(mock: Mock, context: Context, plan = "# Plan") {
	await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);
	await mock.commands.get("plan")?.handler("start", context.ctx);
	await tool(mock, "plan_mode_complete")("c", { plan }, undefined, undefined, context.ctx);
	await mock.commands.get("plan")?.handler("implement", context.ctx);
	assert.equal(context.statuses.get("plan-mode"), "▶ plan · implementing");
	return planFilePathForSession("test-session");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a /plan start issued while the archive is pending is not undone when it lands", async () => {
	// The reviewed defect: the stale completion cleared the new planning state,
	// and with it the edit/write block, while the widget still said planning.
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi);
		const context = selecting("Mark as implemented");
		await planAndImplement(mock, context);
		const held = heldLink();
		await withLink(held.link, async () => {
			const menu = mock.commands.get("plan")?.handler("", context.ctx);
			await settle();
			await mock.commands.get("plan")?.handler("start", context.ctx);
			assert.equal(context.statuses.get("plan-mode"), "◆ plan · revising");
			held.release();
			await menu;
			await settle();
		});
		assert.equal(context.statuses.get("plan-mode"), "◆ plan · revising", "the newer workflow owns the state");
		const block = await mock.events.get("tool_call")?.[0]?.({ toolName: "edit" }, context.ctx);
		assert.equal((block as { block?: boolean } | undefined)?.block, true, "planning still blocks edit");
		assert.ok(!context.notifications.some((n) => /Plan implemented/.test(n.message)), "no stale success");
	});
});

test("'Start a new plan' held across shutdown neither re-enters planning nor writes state", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi);
		const context = selecting("Start a new plan");
		await planAndImplement(mock, context);
		const held = heldLink();
		await withLink(held.link, async () => {
			const menu = mock.commands.get("plan")?.handler("", context.ctx);
			await settle();
			await mock.events.get("session_shutdown")?.[0]?.({}, context.ctx);
			const entriesAtShutdown = mock.entries.length;
			const notificationsAtShutdown = context.notifications.length;
			held.release();
			await menu;
			await settle();
			assert.deepEqual(mock.entries.slice(entriesAtShutdown), [], "nothing written after shutdown");
			assert.deepEqual(context.notifications.slice(notificationsAtShutdown), [], "nothing said after shutdown");
		});
	});
});

test("plan_implemented superseded by a session replacement reports it instead of writing", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi);
		const context = createMockContext({ hasUI: true, mode: "tui" });
		await planAndImplement(mock, context);
		const held = heldLink();
		await withLink(held.link, async () => {
			const done = tool(mock, "plan_implemented")("c", {}, undefined, undefined, context.ctx);
			await new Promise((resolve) => setImmediate(resolve));
			const replacement = createMockContext({ hasUI: true, mode: "tui" });
			await mock.events.get("session_start")?.[0]?.({ reason: "new" }, replacement.ctx);
			const entriesAtReplace = mock.entries.length;
			held.release();
			await assert.rejects(done as Promise<unknown>, /superseded/);
			assert.deepEqual(mock.entries.slice(entriesAtReplace), []);
		});
	});
});

test("an archive the filesystem refuses is reported and leaves the active plan intact", async () => {
	await withAgentDir(async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", onUnhandled);
		try {
			const mock = createMockPi({ activeTools: ["read", "edit"] });
			planMode(mock.pi);
			const context = selecting("Mark as implemented");
			const planPath = await planAndImplement(mock, context);
			const refusing: typeof fs.promises.link = async () => {
				const error = new Error("EOPNOTSUPP") as NodeJS.ErrnoException;
				error.code = "EOPNOTSUPP";
				throw error;
			};
			await withLink(refusing, async () => {
				await mock.commands.get("plan")?.handler("", context.ctx);
				await settle();
			});
			assert.deepEqual(unhandled, []);
			assert.equal(context.statuses.get("plan-mode"), "▶ plan · implementing");
			assert.deepEqual(context.notifications.at(-1), {
				message: "Unable to archive the plan: EOPNOTSUPP. The active plan is unchanged.",
				level: "error",
			});
			assert.equal(await readFile(planPath, "utf8"), "# Plan\n", "the live plan is untouched");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

test("'Start a new plan' does not enter planning when the archive fails", async () => {
	await withAgentDir(async () => {
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi);
		const context = selecting("Start a new plan");
		await planAndImplement(mock, context);
		const refusing: typeof fs.promises.link = async () => {
			throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		};
		await withLink(refusing, async () => {
			await mock.commands.get("plan")?.handler("", context.ctx);
			await settle();
		});
		assert.equal(context.statuses.get("plan-mode"), "▶ plan · implementing");
		assert.match(context.notifications.at(-1)?.message ?? "", /Unable to archive/);
	});
});

test("archivePlanFile refuses to unlink a plan that was replaced while it was being archived", async () => {
	await withAgentDir(async () => {
		const path = planFilePathForSession("s");
		await writePlanFile(path, "# original");
		// A writer that is not this module: rename a new inode into the slot
		// between the link and the unlink.
		const swapping: typeof fs.promises.link = async (source, target) => {
			await realLink(source, target);
			await writeFile(`${source}.swap`, "# replacement\n");
			await fs.promises.rename(`${source}.swap`, source);
		};
		await withLink(swapping, async () => {
			await assert.rejects(archivePlanFile(path), /was replaced while it was being archived/);
		});
		assert.equal(await readFile(path, "utf8"), "# replacement\n", "the newer plan survives");
		assert.equal(await readFile(join(plansDirectory(), "s.1.md"), "utf8"), "# original\n");
	});
});

test("archivePlanFile serializes with writes to the same slot", async () => {
	await withAgentDir(async () => {
		const path = planFilePathForSession("s");
		await writePlanFile(path, "# first");
		const held = heldLink();
		await withLink(held.link, async () => {
			const archive = archivePlanFile(path);
			const write = writePlanFile(path, "# second");
			let written = false;
			void write.then(() => (written = true));
			await settle();
			assert.equal(written, false, "the write waits for the archive");
			held.release();
			assert.equal(await archive, join(plansDirectory(), "s.1.md"));
			await write;
		});
		assert.equal(await readFile(path, "utf8"), "# second\n");
		assert.equal(await readFile(join(plansDirectory(), "s.1.md"), "utf8"), "# first\n");
	});
});

test("archivePlanFile refuses symlinks and handles extensionless paths", async () => {
	await withAgentDir(async () => {
		const directory = plansDirectory();
		await mkdir(directory, { recursive: true });
		await writePlanFile(join(directory, "target.md"), "# v1");
		await symlink(join(directory, "target.md"), join(directory, "sym.md"));
		await assert.rejects(archivePlanFile(join(directory, "sym.md")), /refusing to archive a symlink/);
		assert.equal(await readFile(join(directory, "target.md"), "utf8"), "# v1\n", "the target is untouched");

		await writePlanFile(join(directory, "noext"), "# x");
		assert.equal(await archivePlanFile(join(directory, "noext")), join(directory, "noext.1"));
		assert.equal(await archivePlanFile(join(directory, "missing.md")), undefined);
	});
});

test("a parent whose fresh child finished the shared plan follows the archive on resume", async () => {
	await withAgentDir(async () => {
		// The parent's last entry: ready plan, Plan mode still on. The child
		// then archived the shared file in its own session.
		const planPath = planFilePathForSession("test-session");
		await writePlanFile(planPath, "# Shared");
		assert.equal(await archivePlanFile(planPath), join(plansDirectory(), "test-session.1.md"));
		const entries = [
			{ type: "custom", customType: STATE_ENTRY_TYPE, data: { enabled: true, awaitingAction: true, planPath } },
		];
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi);
		const context = createMockContext({
			hasUI: true,
			mode: "tui",
			sessionManager: {
				getSessionId: () => "test-session",
				getSessionFile: () => "/sessions/parent.jsonl",
				getBranch: () => entries,
				getEntries: () => entries,
			},
		});

		await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);

		assert.match(context.notifications.at(-1)?.message ?? "", /archived elsewhere.*test-session\.1\.md/);
		assert.equal(context.statuses.get("plan-mode"), "◆ plan · drafting", "still planning, no ready plan");
		const persisted = mock.entries.at(-1)?.data as { planPath?: string; archivePath?: string; awaitingAction: boolean };
		assert.equal(persisted.planPath, undefined);
		assert.equal(persisted.awaitingAction, false);
		assert.equal(persisted.archivePath, join(plansDirectory(), "test-session.1.md"));

		// /plan show still finds it, labelled as history.
		await mock.commands.get("plan")?.handler("show", context.ctx);
		assert.ok(
			!context.notifications.some((n) => /No completed plan is available/.test(n.message)),
			"the archive is shown rather than 'nothing'",
		);
	});
});

test("a restored pointer to a file that is simply gone is cleared and reported", async () => {
	await withAgentDir(async () => {
		const planPath = planFilePathForSession("test-session");
		const entries = [
			{ type: "custom", customType: STATE_ENTRY_TYPE, data: { enabled: false, awaitingAction: false, planPath } },
		];
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi);
		const context = createMockContext({
			hasUI: true,
			mode: "tui",
			sessionManager: {
				getSessionId: () => "test-session",
				getSessionFile: () => "/sessions/parent.jsonl",
				getBranch: () => entries,
				getEntries: () => entries,
			},
		});
		await mock.events.get("session_start")?.[0]?.({ reason: "resume" }, context.ctx);
		assert.equal(context.notifications.at(-1)?.message, "The plan file is gone; the stored plan pointer was cleared.");
		assert.equal(context.statuses.get("plan-mode"), undefined);
	});
});

test("staging happens on input, so before_agent_start finds the tool already active", async () => {
	// Pi snapshots the base system prompt before before_agent_start; a tool
	// staged inside that hook ships without its guideline until the next
	// turn. The input event fires before the snapshot.
	await withAgentDir(async () => {
		const planPath = planFilePathForSession("test-session");
		await writePlanFile(planPath, "# Plan");
		// Mirrors the fresh-destination flow: the session starts empty, and the
		// seeded state entry is appended before its first prompt arrives.
		const entries: Array<{ type: string; customType: string; data: unknown }> = [];
		const mock = createMockPi({ activeTools: ["read", "edit"] });
		planMode(mock.pi);
		const context = createMockContext({
			hasUI: true,
			mode: "tui",
			sessionManager: {
				getSessionId: () => "test-session",
				getSessionFile: () => "/sessions/fresh.jsonl",
				getBranch: () => entries,
				getEntries: () => entries,
			},
		});
		await mock.events.get("session_start")?.[0]?.({ reason: "new" }, context.ctx);
		assert.deepEqual(mock.setActiveToolsCalls, [], "a new session stages nothing until its first prompt");
		entries.push({ type: "custom", customType: STATE_ENTRY_TYPE, data: { enabled: false, awaitingAction: false, planPath } });

		await mock.events.get("input")?.[0]?.({ text: "implement", source: "extension" }, context.ctx);
		assert.deepEqual(mock.setActiveToolsCalls, [
			["read", "edit", "plan_implemented", "update_plan"],
		]);

		const before = mock.setActiveToolsCalls.length;
		await mock.events.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, context.ctx);
		assert.equal(mock.setActiveToolsCalls.length, before, "before_agent_start has nothing left to stage");
	});
});
