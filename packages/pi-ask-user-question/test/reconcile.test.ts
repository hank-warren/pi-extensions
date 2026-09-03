/**
 * The headless-strip contract.
 *
 * This is the mechanism that stops subagent children from blocking on a human
 * or escalating questions to the supervisor. If these tests are ever "fixed"
 * by relaxing them, read docs/specs/pi-ask-user-question.md §2 and §7 first —
 * no-subagent-escalation is an explicit non-goal.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reconcileTool } from "../reconcile.ts";
import { TOOL_NAME } from "../tool/schema.ts";

function fakePi(
	tools: string[],
	options: { toolSourcePath?: string; toolBaseDir?: string } = {},
) {
	let active = [...tools];
	let writes = 0;
	const availability: boolean[] = [];
	return {
		api: {
			getActiveTools: () => [...active],
			setActiveTools: (next: string[]) => {
				active = [...next];
				writes += 1;
			},
			...(options.toolSourcePath === undefined && options.toolBaseDir === undefined
				? {}
				: {
						getAllTools: () => [
							{
								name: TOOL_NAME,
								sourceInfo: {
									...(options.toolSourcePath === undefined
										? {}
										: { path: options.toolSourcePath }),
									...(options.toolBaseDir === undefined ? {} : { baseDir: options.toolBaseDir }),
								},
							},
						],
					}),
			events: {
				emit: (_channel: string, payload: { available: boolean }) => {
					availability.push(payload.available);
				},
			},
		} as never,
		get active() {
			return active;
		},
		get writes() {
			return writes;
		},
		availability,
	};
}

const ctx = (hasUI: boolean) => ({ hasUI }) as never;

test("headless runs get the tool stripped", () => {
	const pi = fakePi(["bash", TOOL_NAME, "read"]);
	reconcileTool(pi.api, ctx(false));
	assert.deepEqual(pi.active, ["bash", "read"]);
});

test("interactive runs get the tool restored", () => {
	const pi = fakePi(["bash", "read"]);
	reconcileTool(pi.api, ctx(true));
	assert.ok(pi.active.includes(TOOL_NAME));
});

test("stripping leaves every sibling tool untouched", () => {
	const pi = fakePi(["bash", TOOL_NAME, "read", "todo"]);
	reconcileTool(pi.api, ctx(false));
	assert.deepEqual(pi.active, ["bash", "read", "todo"]);
});

test("reconciling is idempotent and does not rewrite a correct tool set", () => {
	const headless = fakePi(["bash"]);
	reconcileTool(headless.api, ctx(false));
	reconcileTool(headless.api, ctx(false));
	assert.equal(headless.writes, 0, "no write when already absent");

	const interactive = fakePi(["bash", TOOL_NAME]);
	reconcileTool(interactive.api, ctx(true));
	assert.equal(interactive.writes, 0, "no write when already present");
});

test("an intentionally excluded third-party implementation is never reactivated", () => {
	// Another package owns the registered tool and something deliberately took
	// it out of the active set: re-adding it would resurrect a tool the host
	// chose to exclude, and it would not be our dialog behind the name.
	const pi = fakePi(["bash", "read"], { toolSourcePath: "/other/package/index.ts" });
	const available = reconcileTool(pi.api, ctx(true), "/our/package/index.ts");
	assert.deepEqual(pi.active, ["bash", "read"]);
	assert.equal(pi.writes, 0);
	assert.equal(available, false);

	// Our own registration is restored as before.
	const ours = fakePi(["bash"], { toolSourcePath: "/our/package/index.ts" });
	assert.equal(reconcileTool(ours.api, ctx(true), "/our/package/index.ts"), true);
	assert.ok(ours.active.includes(TOOL_NAME));
});

test("a symlinked install still counts as ours, so the tool is restored", (t) => {
	// The install shapes that matter all reach the package through a symlink:
	// npm workspaces, pnpm, and `npm link`. Node resolves `import.meta.url` to
	// the real path, while Pi passes `sourceInfo.baseDir` through untouched — so
	// a lexical compare sees two different directories for the same package,
	// concludes the tool is somebody else's, and never restores it after the
	// first headless run. That leaves an interactive session with no question
	// tool at all, which is the exact failure the availability read-back exists
	// to prevent.
	const root = mkdtempSync(join(tmpdir(), "pi-auq-symlink-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const realDir = join(root, "packages", "pi-ask-user-question");
	mkdirSync(realDir, { recursive: true });
	const linkDir = join(root, "node_modules", "pi-ask-user-question");
	mkdirSync(join(root, "node_modules"), { recursive: true });
	symlinkSync(realDir, linkDir, "dir");

	// Pi reports the symlinked spelling; we report the realpath one.
	const viaBaseDir = fakePi(["bash"], { toolBaseDir: linkDir });
	assert.equal(reconcileTool(viaBaseDir.api, ctx(true), join(realDir, "index.ts")), true);
	assert.ok(viaBaseDir.active.includes(TOOL_NAME), "restored through a symlinked baseDir");

	// Same for the path branch, which is what a host with no baseDir reports.
	const viaPath = fakePi(["bash"], { toolSourcePath: join(linkDir, "index.ts") });
	assert.equal(reconcileTool(viaPath.api, ctx(true), join(realDir, "index.ts")), true);
	assert.ok(viaPath.active.includes(TOOL_NAME), "restored through a symlinked path");

	// The exclusion contract is unchanged: a genuinely different package still
	// loses, so canonicalizing has not turned the check into a rubber stamp.
	const otherDir = join(root, "packages", "someone-elses");
	mkdirSync(otherDir, { recursive: true });
	const foreign = fakePi(["bash"], { toolBaseDir: otherDir });
	assert.equal(reconcileTool(foreign.api, ctx(true), join(realDir, "index.ts")), false);
	assert.equal(foreign.writes, 0, "a third-party tool is never resurrected");
});

test("a source path that no longer exists falls back to a lexical compare", () => {
	// realpathSync throws on a deleted or unreadable path. Every other branch in
	// ownsRegisteredTool fails open, so this one must not be the exception that
	// silently strips the tool.
	const pi = fakePi(["bash"], { toolBaseDir: "/nonexistent/pkg" });
	assert.equal(reconcileTool(pi.api, ctx(true), "/nonexistent/pkg/index.ts"), true);
	assert.ok(pi.active.includes(TOOL_NAME));
});

test("availability is read back from the host, not assumed from the write", () => {
	// Pi silently ignores a name excluded by --tools or a tool policy, so an
	// accepted setActiveTools is not proof the tool is there. pi-plan-mode drops
	// its own fallback on this signal: a false positive leaves an interactive
	// session with no question tool at all.
	const excluded = new Set([TOOL_NAME]);
	let active = ["bash", "read"];
	const pi = {
		getActiveTools: () => [...active],
		setActiveTools: (next: string[]) => {
			active = next.filter((name) => !excluded.has(name));
		},
		events: { emit() {} },
	} as never;

	assert.equal(reconcileTool(pi, ctx(true)), false, "an excluded tool is never available");
});

test("every reconciliation announces the resulting availability", () => {
	// pi-plan-mode listens for this instead of racing hook order to decide
	// whether its own fallback question tool is needed.
	const pi = fakePi(["bash", TOOL_NAME]);
	assert.equal(reconcileTool(pi.api, ctx(true)), true);
	assert.equal(reconcileTool(pi.api, ctx(false)), false);
	assert.equal(reconcileTool(pi.api, ctx(false)), false);
	assert.deepEqual(pi.availability, [true, false, false]);
});

test("a headless run never ends up with the tool, even after repeated toggles", () => {
	const pi = fakePi(["bash"]);
	reconcileTool(pi.api, ctx(true));
	assert.ok(pi.active.includes(TOOL_NAME));
	reconcileTool(pi.api, ctx(false));
	assert.ok(!pi.active.includes(TOOL_NAME));
	reconcileTool(pi.api, ctx(false));
	assert.ok(!pi.active.includes(TOOL_NAME));
});
