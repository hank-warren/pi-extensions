import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	extractWorktreePaths,
	extractWorktreePathsFromEntries,
	extractWorktreePathsFromToolCall,
	buildPullRequestQuery,
	PR_ABSENT_INTERVAL_MS,
	PR_FAILURE_INTERVAL_MS,
	PR_IDLE_AFTER_MS,
	PR_IDLE_INTERVAL_MS,
	PR_MIN_INTERVAL_MS,
	PR_PENDING_INTERVAL_MS,
	PR_SETTLED_INTERVAL_MS,
	parseGitStatus,
	parsePullRequestResponse,
	readWorktreeMetadata,
	SessionWorktreeTracker,
	selectPullRequest,
	worktreeRootNeedles,
} from "../worktrees.ts";

const WORKTREE_ROOT = "/home/hank/repos/worktrees";
const HOME = "/home/hank";

const HEAD_OID = "0123456789abcdef0123456789abcdef01234567";

function gitStatusOutput(
	branch: string,
	behind = 0,
	dirty = false,
	options: { ahead?: number; head?: string; upstream?: string } = {},
): string {
	const lines = [
		`# branch.oid ${options.head ?? HEAD_OID}`,
		`# branch.head ${branch}`,
		`# branch.upstream ${options.upstream ?? `origin/${branch}`}`,
		`# branch.ab +${options.ahead ?? 0} -${behind}`,
	];
	if (dirty) lines.push("? untracked.txt");
	return `${lines.join("\n")}\n`;
}

async function fixtureWorktree(
	name = "feature-statusline",
	branch = "feature/statusline",
	existingRoot?: string,
): Promise<{ root: string; path: string; gitDir: string }> {
	const root = existingRoot ?? (await mkdtemp(join(tmpdir(), "pi-statusline-worktrees-")));
	const path = join(root, "home", "repos", "worktrees", name);
	const gitDir = join(root, "pi-extensions", ".git", "worktrees", name);
	await mkdir(path, { recursive: true });
	await mkdir(gitDir, { recursive: true });
	await writeFile(join(path, ".git"), `gitdir: ${gitDir}\n`);
	await writeFile(join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
	return { root, path, gitDir };
}

interface FakeNode {
	number: number;
	state: string;
	url?: string;
	headRefOid?: string;
	rollup?: string | null;
}

/** Serves `gh api graphql` from a branch -> PRs map, recording each call's branches. */
function fakeGitHub(prs: Map<string, FakeNode[]>) {
	const calls: string[][] = [];
	let fail = false;
	const respond = (args: string[]) => {
		const branches = args.flatMap((arg) => /^b\d+=(.*)$/s.exec(arg)?.[1] ?? []);
		calls.push(branches);
		if (fail) return { stdout: "", stderr: "HTTP 502", code: 1, killed: false };
		const repository = Object.fromEntries(
			branches.map((branch, index) => [
				`b${index}`,
				{
					nodes: (prs.get(branch) ?? []).map((node) => ({
						number: node.number,
						state: node.state,
						url: node.url ?? `https://github.com/hank-warren/pi-extensions/pull/${node.number}`,
						headRefOid: node.headRefOid ?? HEAD_OID,
						commits: {
							nodes: [{ commit: { statusCheckRollup: node.rollup ? { state: node.rollup } : null } }],
						},
					})),
				},
			]),
		);
		return { stdout: JSON.stringify({ data: { repository } }), stderr: "", code: 0, killed: false };
	};
	return {
		calls,
		respond,
		setFailing(value: boolean) {
			fail = value;
		},
	};
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

test("parseGitStatus derives branch, dirty state, ahead/behind, head, and upstream", () => {
	assert.deepEqual(parseGitStatus(gitStatusOutput("feature/statusline", 3, true, { ahead: 2 })), {
		branch: "feature/statusline",
		dirty: true,
		ahead: 2,
		behind: 3,
		head: HEAD_OID,
		upstream: "origin/feature/statusline",
	});
	assert.deepEqual(
		parseGitStatus(
			"# branch.oid abcdef1234567890abcdef1234567890abcdef12\n# branch.head (detached)\n# branch.ab +0 -0\n",
		),
		{ branch: "abcdef12", dirty: false, ahead: 0, behind: 0, head: "abcdef1234567890abcdef1234567890abcdef12" },
	);
	assert.deepEqual(parseGitStatus("# branch.oid (initial)\n# branch.head main\n"), {
		branch: "main",
		dirty: false,
		ahead: 0,
		behind: 0,
	});
});

test("readWorktreeMetadata derives repository, branch, and common git dir from linked-worktree metadata", async (t) => {
	const fixture = await fixtureWorktree();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));

	assert.deepEqual(await readWorktreeMetadata(fixture.path), {
		path: fixture.path,
		repo: "pi-extensions",
		branch: "feature/statusline",
		commonDir: join(fixture.root, "pi-extensions", ".git"),
	});
});

test("the PR query passes branch names as variables and parses check rollups", () => {
	const query = buildPullRequestQuery(2);
	assert.match(query, /\$b0:String!,\$b1:String!/);
	assert.match(query, /b1:pullRequests\(headRefName:\$b1,first:5,orderBy:\{field:CREATED_AT,direction:DESC\}\)/);

	const node = (number: number, rollup: string | null, url = `https://github.com/o/r/pull/${number}`) => ({
		number,
		state: "open",
		url,
		headRefOid: HEAD_OID,
		commits: { nodes: [{ commit: { statusCheckRollup: rollup ? { state: rollup } : null } }] },
	});
	const parsed = parsePullRequestResponse(
		JSON.stringify({
			data: {
				repository: {
					b0: { nodes: [node(1, "SUCCESS"), node(2, "ERROR"), node(3, "EXPECTED")] },
					b1: { nodes: [node(4, null, "https://evil\u001b]8;;x"), { number: "bad" }] },
				},
			},
		}),
		2,
	);
	assert.deepEqual(parsed, [
		[
			{ number: 1, state: "OPEN", url: "https://github.com/o/r/pull/1", headRefOid: HEAD_OID, checks: "success" },
			{ number: 2, state: "OPEN", url: "https://github.com/o/r/pull/2", headRefOid: HEAD_OID, checks: "failure" },
			{ number: 3, state: "OPEN", url: "https://github.com/o/r/pull/3", headRefOid: HEAD_OID, checks: "pending" },
		],
		[{ number: 4, state: "OPEN", headRefOid: HEAD_OID }],
	]);
	assert.equal(parsePullRequestResponse("not json", 1), undefined);
	assert.equal(parsePullRequestResponse(JSON.stringify({ data: { repository: null } }), 1), undefined);
	assert.equal(parsePullRequestResponse(JSON.stringify({ data: { repository: {} } }), 1), undefined);
});

test("selectPullRequest ignores a finished PR that only shares a reused branch name", () => {
	const merged = { number: 5, state: "MERGED", headRefOid: "old" };
	const open = { number: 9, state: "OPEN", headRefOid: "other" };
	const local = { branch: "fix/x", ahead: 0, head: HEAD_OID, upstream: "origin/main" };

	assert.equal(selectPullRequest([merged, open], local), open, "an open PR always wins");
	assert.equal(selectPullRequest([merged], local), undefined, "fresh work on a reused name stays visible");
	assert.equal(selectPullRequest([merged], { ...local, ahead: 3 }), undefined);
	assert.equal(selectPullRequest([{ ...merged, headRefOid: HEAD_OID }], local)?.number, 5, "same head is this PR");
	assert.equal(
		selectPullRequest([merged], { ...local, upstream: "origin/fix/x" })?.number,
		5,
		"everything pushed to the same-named branch belongs to the newest PR",
	);
	assert.equal(selectPullRequest([merged], { ...local, upstream: "origin/fix/x", ahead: 1 }), undefined);
	assert.equal(selectPullRequest([], local), undefined);
});

test("SessionWorktreeTracker looks up every worktree of a repository in one gh call", async (t) => {
	const first = await fixtureWorktree("alpha", "feat/alpha");
	t.after(() => rm(first.root, { recursive: true, force: true }));
	const second = await fixtureWorktree("beta", "feat/beta", first.root);
	const github = fakeGitHub(new Map([["feat/beta", [{ number: 12, state: "OPEN", rollup: "SUCCESS" }]]]));
	const ghArgs: string[][] = [];
	const tracker = new SessionWorktreeTracker({
		worktreeRoot: join(first.root, "home", "repos", "worktrees"),
		home: join(first.root, "home"),
		now: () => 1_000_000,
		exec: async (command, args, options) => {
			if (command === "git") {
				const branch = args[2] === first.path ? "feat/alpha" : "feat/beta";
				return { stdout: gitStatusOutput(branch, 0, false, { upstream: "origin/main" }), stderr: "", code: 0, killed: false };
			}
			ghArgs.push(args);
			assert.equal(options.cwd, first.path);
			return github.respond(args);
		},
	});

	await tracker.observeToolInput("bash", { command: `ls ${first.path} ${second.path}` });
	assert.deepEqual(github.calls, [["feat/alpha", "feat/beta"]]);
	assert.deepEqual(ghArgs[0]?.slice(0, 6), ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}"]);
	assert.deepEqual(
		tracker.getWorktrees().map((worktree) => [worktree.branch, worktree.pr, worktree.prChecks]),
		[
			["feat/alpha", undefined, undefined],
			["feat/beta", 12, "success"],
		],
	);
});

test("SessionWorktreeTracker polls on a cadence set by PR and CI state", async (t) => {
	const fixture = await fixtureWorktree();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	let now = 1_000_000;
	const prs = new Map<string, FakeNode[]>();
	const github = fakeGitHub(prs);
	const tracker = new SessionWorktreeTracker({
		worktreeRoot: join(fixture.root, "home", "repos", "worktrees"),
		home: join(fixture.root, "home"),
		now: () => now,
		exec: async (command, args) =>
			command === "git"
				? { stdout: gitStatusOutput("feature/statusline"), stderr: "", code: 0, killed: false }
				: github.respond(args),
	});

	await tracker.observeToolInput("read", { path: join(fixture.path, "README.md") });
	assert.equal(github.calls.length, 1);

	// Turn ends no longer call GitHub on every turn.
	now += PR_ABSENT_INTERVAL_MS - 1;
	await tracker.refresh();
	assert.equal(github.calls.length, 1, "a missing PR is not re-asked every turn");

	now += 1;
	prs.set("feature/statusline", [{ number: 10, state: "OPEN", rollup: "PENDING" }]);
	await tracker.pollPullRequests();
	assert.equal(github.calls.length, 2);
	assert.equal(tracker.getWorktrees()[0]?.prChecks, "pending");

	now += PR_PENDING_INTERVAL_MS;
	prs.set("feature/statusline", [{ number: 10, state: "OPEN", rollup: "FAILURE" }]);
	await tracker.pollPullRequests();
	assert.equal(github.calls.length, 3, "running checks are watched closely");
	assert.equal(tracker.getWorktrees()[0]?.prChecks, "failure");

	now += PR_PENDING_INTERVAL_MS;
	await tracker.pollPullRequests();
	assert.equal(github.calls.length, 3, "settled checks fall back to the slow interval");

	now += PR_SETTLED_INTERVAL_MS;
	prs.set("feature/statusline", [{ number: 10, state: "MERGED" }]);
	await tracker.refresh();
	assert.equal(github.calls.length, 4);
	assert.deepEqual(tracker.getWorktrees(), [], "merged PR worktrees are no longer active work");

	now += PR_IDLE_INTERVAL_MS * 10;
	await tracker.refresh();
	assert.equal(github.calls.length, 4, "a merged PR is never polled again");

	await rm(join(fixture.path, ".git"));
	await tracker.refresh();
	assert.deepEqual(tracker.getWorktrees(), []);
	tracker.dispose();
});

test("SessionWorktreeTracker re-checks soon after a commit or push, and slows down while idle", async (t) => {
	const fixture = await fixtureWorktree();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	let now = 1_000_000;
	let status = { ahead: 1, head: HEAD_OID, upstream: "origin/main" };
	const github = fakeGitHub(new Map());
	const tracker = new SessionWorktreeTracker({
		worktreeRoot: join(fixture.root, "home", "repos", "worktrees"),
		home: join(fixture.root, "home"),
		now: () => now,
		exec: async (command, args) =>
			command === "git"
				? { stdout: gitStatusOutput("feature/statusline", 0, false, status), stderr: "", code: 0, killed: false }
				: github.respond(args),
	});

	await tracker.observeToolInput("read", { path: join(fixture.path, "README.md") });
	assert.equal(github.calls.length, 1);
	assert.equal(tracker.getWorktrees()[0]?.ahead, 1);

	status = { ahead: 0, head: HEAD_OID, upstream: "origin/feature/statusline" };
	now += PR_MIN_INTERVAL_MS - 1;
	await tracker.refresh();
	assert.equal(github.calls.length, 1, "local changes still respect the floor");
	now += 1;
	await tracker.refresh();
	assert.equal(github.calls.length, 2, "a push is when a PR is likely to appear");

	// The timer keeps polling between turns...
	now += PR_ABSENT_INTERVAL_MS;
	await tracker.pollPullRequests();
	assert.equal(github.calls.length, 3, "an idle session still notices a new PR");
	// ...but once no turn has ended for a while, the absent interval stretches.
	now += PR_IDLE_AFTER_MS - PR_ABSENT_INTERVAL_MS;
	await tracker.pollPullRequests();
	assert.equal(github.calls.length, 3);
	now += PR_IDLE_INTERVAL_MS - (PR_IDLE_AFTER_MS - PR_ABSENT_INTERVAL_MS);
	await tracker.pollPullRequests();
	assert.equal(github.calls.length, 4);
	tracker.dispose();
});

test("SessionWorktreeTracker keeps the last known PR through failed lookups", async (t) => {
	const fixture = await fixtureWorktree();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	let now = 1_000_000;
	const github = fakeGitHub(new Map([["feature/statusline", [{ number: 7, state: "OPEN", rollup: "SUCCESS" }]]]));
	let changes = 0;
	const tracker = new SessionWorktreeTracker({
		worktreeRoot: join(fixture.root, "home", "repos", "worktrees"),
		home: join(fixture.root, "home"),
		now: () => now,
		onChange: () => changes++,
		exec: async (command, args) =>
			command === "git"
				? { stdout: gitStatusOutput("feature/statusline"), stderr: "", code: 0, killed: false }
				: github.respond(args),
	});

	await tracker.observeToolInput("read", { path: join(fixture.path, "README.md") });
	assert.deepEqual(tracker.getWorktrees(), [
		{
			path: fixture.path,
			repo: "pi-extensions",
			branch: "feature/statusline",
			dirty: false,
			ahead: 0,
			behind: 0,
			pr: 7,
			prState: "OPEN",
			prUrl: "https://github.com/hank-warren/pi-extensions/pull/7",
			prChecks: "success",
		},
	]);
	assert.ok(changes >= 1);

	github.setFailing(true);
	now += PR_SETTLED_INTERVAL_MS;
	await tracker.pollPullRequests();
	assert.equal(github.calls.length, 2);
	assert.equal(tracker.getWorktrees()[0]?.pr, 7);

	github.setFailing(false);
	now += PR_FAILURE_INTERVAL_MS;
	await tracker.pollPullRequests();
	assert.equal(github.calls.length, 3, "a failure retries on the short interval");
	tracker.dispose();
});
