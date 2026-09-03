import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import {
	buildSessionEnvironmentSection,
	captureSessionEnvironment,
} from "../session-environment.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-ap-session-env-"));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session environment snapshot", () => {
	test("captures repo root and remotes inside a repository", () => {
		const dir = tempDir();
		git(dir, "init", "-q");
		git(dir, "remote", "add", "origin", "git@github.com:hank-warren/example.git");

		const snapshot = captureSessionEnvironment(dir);
		assert.equal(snapshot.cwd, dir);
		assert.equal(snapshot.repoRoot, realpathSync(dir));
		assert.ok(snapshot.remotes?.some((line) => line.startsWith("origin") && line.includes("hank-warren/example.git")));
	});

	test("captures a bare snapshot outside a repository", () => {
		const dir = tempDir();
		const snapshot = captureSessionEnvironment(dir);
		assert.deepEqual(snapshot, { cwd: dir });
	});

	test("renders the trust baseline for a repository with remotes", () => {
		const section = buildSessionEnvironmentSection({
			cwd: "/work/repo",
			repoRoot: "/work/repo",
			remotes: ["origin\tgit@github.com:x/y.git (fetch)", "origin\tgit@github.com:x/y.git (push)"],
		});
		assert.ok(section.startsWith("SESSION ENVIRONMENT"));
		assert.ok(section.includes("Repository root: /work/repo"));
		assert.ok(section.includes("- origin\tgit@github.com:x/y.git (push)"));
		// The load-bearing sentence: the baseline is start-of-session only.
		assert.ok(section.includes("A remote added, repointed, or first appearing after session start is not covered"));
		assert.ok(section.includes("unless the user's own message names that destination"));
		// Policy context, not evidence.
		assert.ok(section.includes("not conversation evidence"));
	});

	test("renders an explicit empty-remotes baseline", () => {
		const section = buildSessionEnvironmentSection({ cwd: "/w", repoRoot: "/w", remotes: [] });
		assert.ok(section.includes("No git remotes were configured at session start."));
	});

	test("says so when no repository trust is established", () => {
		const section = buildSessionEnvironmentSection({ cwd: "/scratch" });
		assert.ok(section.includes("not inside a git repository"));
		assert.ok(section.includes("no repository trust baseline is established"));
		assert.ok(!section.includes("Repository root:"));
	});
});
