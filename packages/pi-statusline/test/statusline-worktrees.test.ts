import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	extractWorktreePaths,
	extractWorktreePathsFromEntries,
	extractWorktreePathsFromToolCall,
	parseGitStatus,
	PR_ABSENT_TTL_MS,
	PR_TTL_MS,
	readWorktreeMetadata,
	SessionWorktreeTracker,
	worktreeRootNeedles,
} from "../worktrees.ts";

const WORKTREE_ROOT = "/home/hank/repos/worktrees";
const HOME = "/home/hank";

function gitStatusOutput(branch: string, behind = 0, dirty = false): string {
	const lines = [
		"# branch.oid 0123456789abcdef0123456789abcdef01234567",
		`# branch.head ${branch}`,
		`# branch.upstream origin/${branch}`,
		`# branch.ab +0 -${behind}`,
	];
	if (dirty) lines.push("? untracked.txt");
	return `${lines.join("\n")}\n`;
}

async function fixtureWorktree(): Promise<{ root: string; path: string; gitDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-statusline-worktrees-"));
	const path = join(root, "home", "repos", "worktrees", "feature-statusline");
	const gitDir = join(root, "pi-extensions", ".git", "worktrees", "feature-statusline");
	await mkdir(path, { recursive: true });
	await mkdir(gitDir, { recursive: true });
	await writeFile(join(path, ".git"), `gitdir: ${gitDir}\n`);
	await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/feature/statusline\n");
	return { root, path, gitDir };
}

test("extractWorktreePaths finds conventional worktrees in nested tool inputs", () => {
	assert.deepEqual(
		extractWorktreePaths(
			{
				path: "/home/hank/repos/worktrees/fix-alerts/playbook.yml",
				command: "cd $HOME/repos/worktrees/feature-statusline && npm test",
				nested: ["~/repos/worktrees/fix-alerts/README.md"],
			},
			WORKTREE_ROOT,
			HOME,
		),
		[
			"/home/hank/repos/worktrees/feature-statusline",
			"/home/hank/repos/worktrees/fix-alerts",
		],
	);
});

test("worktree extraction follows the configured root instead of the legacy hardcoded one", () => {
	const custom = "/home/hank/code/trees";
	assert.deepEqual(worktreeRootNeedles(custom, HOME), [
		"/home/hank/code/trees/",
		"~/code/trees/",
		"$HOME/code/trees/",
	]);
	assert.deepEqual(
		extractWorktreePaths(
			{
				absolute: "/home/hank/code/trees/alpha/src/index.ts",
				tilde: "~/code/trees/beta",
				legacy: "/home/hank/repos/worktrees/gamma",
			},
			custom,
			HOME,
		),
		["/home/hank/code/trees/alpha", "/home/hank/code/trees/beta"],
	);

	// A root outside $HOME has no `~` spelling, so only the absolute form matches.
	const outside = "/srv/worktrees";
	assert.deepEqual(worktreeRootNeedles(outside, HOME), ["/srv/worktrees/"]);
	assert.deepEqual(
		extractWorktreePaths({ a: "/srv/worktrees/one/README.md", b: "~/repos/worktrees/two" }, outside, HOME),
		["/srv/worktrees/one"],
	);
});

test("Bash extraction ignores heredoc payloads but keeps executable command text", () => {
	const command = `node - <<'NODE'
const fixture = "/home/hank/repos/worktrees/mentioned-only";
NODE
cd /home/hank/repos/worktrees/actually-used && npm test`;

	assert.deepEqual(extractWorktreePathsFromToolCall("bash", { command }, WORKTREE_ROOT, HOME), [
		"/home/hank/repos/worktrees/actually-used",
	]);
	assert.deepEqual(
		extractWorktreePathsFromToolCall(
			"bash",
			{ command: "git worktree add /home/hank/repos/worktrees/new-worktree -b fix/new-worktree origin/main" },
			WORKTREE_ROOT,
			HOME,
		),
		["/home/hank/repos/worktrees/new-worktree"],
	);
});

test("entry reconstruction counts targeted tool calls but ignores prose, heredoc payloads, and tool results", () => {
	const path = "/home/hank/repos/worktrees/feature-statusline";
	const entries = [
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: `${path} is mentioned in prose` },
					{
						type: "toolCall",
						name: "bash",
						arguments: { command: `node <<'EOF'\nconst value = "${path}";\nEOF` },
					},
					{ type: "toolCall", name: "read", arguments: { path: `${path}/README.md` } },
				],
			},
		},
		{
			type: "message",
			message: { role: "toolResult", content: [{ type: "text", text: "/home/hank/repos/worktrees/ignored" }] },
		},
	];

	assert.deepEqual(extractWorktreePathsFromEntries(entries, WORKTREE_ROOT, HOME), [path]);
});

test("parseGitStatus derives branch, dirty state, and upstream-behind count", () => {
	assert.deepEqual(parseGitStatus(gitStatusOutput("feature/statusline", 3, true)), {
		branch: "feature/statusline",
		dirty: true,
		behind: 3,
	});
	assert.deepEqual(
		parseGitStatus(
			"# branch.oid abcdef1234567890abcdef1234567890abcdef12\n# branch.head (detached)\n# branch.ab +0 -0\n",
		),
		{ branch: "abcdef12", dirty: false, behind: 0 },
	);
});

test("readWorktreeMetadata derives repository and branch from linked-worktree metadata", async (t) => {
	const fixture = await fixtureWorktree();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));

	assert.deepEqual(await readWorktreeMetadata(fixture.path), {
		path: fixture.path,
		repo: "pi-extensions",
		branch: "feature/statusline",
	});
});

test("SessionWorktreeTracker quickly discovers a PR created after the worktree was tracked", async (t) => {
	const fixture = await fixtureWorktree();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	let now = 1_000_000;
	let ghCalls = 0;
	let prExists = false;
	const tracker = new SessionWorktreeTracker({
		worktreeRoot: join(fixture.root, "home", "repos", "worktrees"),
		home: join(fixture.root, "home"),
		now: () => now,
		exec: async (command) => {
			if (command === "git") {
				return { stdout: gitStatusOutput("feature/statusline"), stderr: "", code: 0, killed: false };
			}
			ghCalls++;
			return prExists
				? { stdout: '{"number":10,"state":"OPEN"}\n', stderr: "", code: 0, killed: false }
				: { stdout: "", stderr: "no pull requests found", code: 1, killed: false };
		},
	});

	await tracker.observeToolInput("read", { path: join(fixture.path, "README.md") });
	assert.equal(ghCalls, 1);
	assert.equal(tracker.getWorktrees()[0]?.pr, undefined);

	await tracker.refresh();
	assert.equal(ghCalls, 1, "missing PR lookup should be briefly cached");

	now += PR_ABSENT_TTL_MS + 1;
	prExists = true;
	await tracker.refresh();
	assert.equal(ghCalls, 2);
	assert.equal(tracker.getWorktrees()[0]?.pr, 10);
});

test("SessionWorktreeTracker resolves PRs, caches lookups, hides terminal PRs, and prunes worktrees", async (t) => {
	const fixture = await fixtureWorktree();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	let ghCalls = 0;
	let changes = 0;
	let now = 1_000_000;
	let prState = "OPEN";
	let dirty = false;
	let behind = 0;
	const tracker = new SessionWorktreeTracker({
		worktreeRoot: join(fixture.root, "home", "repos", "worktrees"),
		home: join(fixture.root, "home"),
		now: () => now,
		onChange: () => changes++,
		exec: async (command) => {
			if (command === "git") {
				return { stdout: gitStatusOutput("feature/statusline", behind, dirty), stderr: "", code: 0, killed: false };
			}
			assert.equal(command, "gh");
			ghCalls++;
			return { stdout: JSON.stringify({ number: 7, state: prState }), stderr: "", code: 0, killed: false };
		},
	});

	await tracker.observeToolInput("read", { path: join(fixture.path, "README.md") });
	assert.deepEqual(tracker.getWorktrees(), [
		{
			path: fixture.path,
			repo: "pi-extensions",
			branch: "feature/statusline",
			dirty: false,
			behind: 0,
			pr: 7,
			prState: "OPEN",
		},
	]);
	assert.equal(ghCalls, 1);
	assert.ok(changes >= 1);

	dirty = true;
	behind = 2;
	await tracker.refresh();
	assert.equal(ghCalls, 1, "PR lookup should remain cached within the TTL");
	assert.deepEqual(tracker.getWorktrees()[0], {
		path: fixture.path,
		repo: "pi-extensions",
		branch: "feature/statusline",
		dirty: true,
		behind: 2,
		pr: 7,
		prState: "OPEN",
	});

	now += PR_TTL_MS + 1;
	prState = "MERGED";
	await tracker.refresh();
	assert.equal(ghCalls, 2);
	assert.deepEqual(tracker.getWorktrees(), [], "merged PR worktrees are no longer active work");

	await rm(join(fixture.path, ".git"));
	await tracker.refresh();
	assert.deepEqual(tracker.getWorktrees(), []);
});
