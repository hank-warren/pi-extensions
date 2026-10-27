import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

/** How often the poll timer checks whether any repository is due; a due-less tick costs nothing. */
export const PR_POLL_TICK_MS = 5_000;
/** A branch with no PR yet. */
export const PR_ABSENT_INTERVAL_MS = 60_000;
/** An open PR whose checks are still running. */
export const PR_PENDING_INTERVAL_MS = 30_000;
/** An open PR whose checks have settled (or that has none). */
export const PR_SETTLED_INTERVAL_MS = 5 * 60_000;
/** A failed lookup, so a network blip does not hide CI for a whole settled interval. */
export const PR_FAILURE_INTERVAL_MS = 60_000;
/** Absent and settled lookups slow to this once the session has been idle for PR_IDLE_AFTER_MS. */
export const PR_IDLE_INTERVAL_MS = 10 * 60_000;
export const PR_IDLE_AFTER_MS = 10 * 60_000;
/** Floor between lookups when local state (branch, commit, push) changes. */
export const PR_MIN_INTERVAL_MS = 15_000;
/** Candidates fetched per branch, newest first; enough to skip past an old PR that reused the name. */
const PR_CANDIDATES = 5;
// The URL is embedded in an OSC 8 sequence, so control characters must never reach it.
const SAFE_URL = /^https?:\/\/[^\s\x00-\x1f\x7f]+$/;

export interface GitRepositoryStatus {
	branch: string;
	dirty: boolean;
	ahead: number;
	behind: number;
	/** Full HEAD commit id; absent on an unborn branch. */
	head?: string;
	/** Upstream ref such as `origin/main`; absent when none is configured. */
	upstream?: string;
}

/** Combined state of an open PR's head-commit checks; absent when it has none. */
export type PullRequestChecks = "pending" | "success" | "failure";

export interface SessionWorktree {
	path: string;
	repo: string;
	branch: string;
	dirty: boolean;
	ahead: number;
	behind: number;
	pr?: number;
	prState?: string;
	prUrl?: string;
	prChecks?: PullRequestChecks;
}

interface CachedWorktree extends SessionWorktree {
	/** The repository's common git dir; worktrees sharing it share one PR lookup. */
	commonDir: string;
	head?: string;
	upstream?: string;
	prCheckedAt: number;
	/** Local state at the last lookup; a different one makes the PR due sooner. */
	prCheckedKey?: string;
	prFailed?: boolean;
}

interface WorktreeMetadata {
	path: string;
	repo: string;
	branch: string;
	commonDir: string;
}

export interface PullRequestCandidate {
	number: number;
	state: string;
	url?: string;
	headRefOid?: string;
	checks?: PullRequestChecks;
}

interface WorktreeTrackerHost {
	exec(
		command: string,
		args: string[],
		options: { cwd?: string; timeout?: number; signal?: AbortSignal },
	): Promise<ExecResult>;
	/** Directory whose immediate children are tracked as session worktrees. */
	worktreeRoot: string;
	/** Home directory used to recognise `~`/`$HOME` spellings of the root. */
	home?: string;
	now?: () => number;
	onChange?: () => void;
}

export function parseGitStatus(output: string): GitRepositoryStatus | undefined {
	let branch: string | undefined;
	let oid: string | undefined;
	let upstream: string | undefined;
	let ahead = 0;
	let behind = 0;
	let dirty = false;

	for (const line of output.split(/\r?\n/)) {
		if (line.startsWith("# branch.oid ")) oid = line.slice("# branch.oid ".length).trim();
		else if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length).trim();
		else if (line.startsWith("# branch.upstream ")) upstream = line.slice("# branch.upstream ".length).trim();
		else if (line.startsWith("# branch.ab ")) {
			const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
			if (match) {
				ahead = Number.parseInt(match[1] ?? "0", 10);
				behind = Number.parseInt(match[2] ?? "0", 10);
			}
		} else if (line.length > 0 && !line.startsWith("# ")) dirty = true;
	}

	const head = oid && oid !== "(initial)" ? oid : undefined;
	if (branch === "(detached)") branch = head ? head.slice(0, 8) : "detached";
	if (!branch || branch === "(unknown)") return undefined;
	const status: GitRepositoryStatus = { branch, dirty, ahead, behind };
	if (head) status.head = head;
	if (upstream) status.upstream = upstream;
	return status;
}

export async function readGitStatus(
	exec: WorktreeTrackerHost["exec"],
	path: string,
	signal?: AbortSignal,
): Promise<GitRepositoryStatus | undefined> {
	const result = await exec(
		"git",
		[
			"--no-optional-locks",
			"-C",
			path,
			"status",
			"--porcelain=v2",
			"--branch",
			"--untracked-files=normal",
			"--no-renames",
		],
		{ timeout: 3_000, signal },
	);
	return result.code === 0 ? parseGitStatus(result.stdout) : undefined;
}

function visitStrings(value: unknown, visit: (value: string) => void): void {
	if (typeof value === "string") {
		visit(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) visitStrings(item, visit);
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const item of Object.values(value)) visitStrings(item, visit);
}

function trimTrailingSlashes(path: string): string {
	return path.replace(/\/+$/, "") || path.slice(0, 1);
}

/**
 * Spellings of the configured root that may appear in tool arguments: the
 * absolute path, plus the `~/` and `$HOME/` forms when it lives under home.
 */
export function worktreeRootNeedles(worktreeRoot: string, home: string = homedir()): string[] {
	const root = trimTrailingSlashes(worktreeRoot);
	if (root.length === 0) return [];
	const needles = [`${root}/`];
	const base = trimTrailingSlashes(home ?? "");
	if (base.length > 0 && root.startsWith(`${base}/`)) {
		const relative = root.slice(base.length + 1);
		if (relative.length > 0) needles.push(`~/${relative}/`, `$HOME/${relative}/`);
	}
	return needles;
}

export function extractWorktreePaths(value: unknown, worktreeRoot: string, home: string = homedir()): string[] {
	const names = new Set<string>();
	const needles = worktreeRootNeedles(worktreeRoot, home);
	if (needles.length === 0) return [];

	visitStrings(value, (text) => {
		for (const needle of needles) {
			let rest = text;
			while (true) {
				const index = rest.indexOf(needle);
				if (index < 0) break;
				rest = rest.slice(index + needle.length);
				const name = rest.match(/^[a-zA-Z0-9._-]+/)?.[0];
				if (name) names.add(name);
				if (rest.length === 0) break;
				rest = rest.slice(Math.max(1, name?.length ?? 0));
			}
		}
	});

	const root = trimTrailingSlashes(worktreeRoot);
	return [...names].sort().map((name) => join(root, name));
}

function stripHeredocBodies(command: string): string {
	const visible: string[] = [];
	const delimiters: Array<{ value: string; stripTabs: boolean }> = [];

	for (const line of command.split(/\r?\n/)) {
		const active = delimiters[0];
		if (active) {
			const candidate = active.stripTabs ? line.replace(/^\t+/, "") : line;
			if (candidate === active.value) delimiters.shift();
			continue;
		}

		visible.push(line);
		const pattern = /(?<!<)<<(?!<)(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([^\s;&|<>]+))/g;
		for (const match of line.matchAll(pattern)) {
			const value = match[2] ?? match[3] ?? match[4];
			if (value) delimiters.push({ value, stripTabs: match[1] === "-" });
		}
	}

	return visible.join("\n");
}

export function extractWorktreePathsFromToolCall(
	toolName: string,
	input: unknown,
	worktreeRoot: string,
	home: string = homedir(),
): string[] {
	const baseName = toolName.slice(toolName.lastIndexOf(".") + 1);
	if (baseName !== "bash" || !input || typeof input !== "object" || Array.isArray(input)) {
		return extractWorktreePaths(input, worktreeRoot, home);
	}

	const command = (input as { command?: unknown }).command;
	return typeof command === "string"
		? extractWorktreePaths(stripHeredocBodies(command), worktreeRoot, home)
		: [];
}

export function extractWorktreePathsFromEntries(
	entries: readonly unknown[],
	worktreeRoot: string,
	home: string = homedir(),
): string[] {
	const paths = new Set<string>();

	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: unknown; message?: unknown };
		if (candidate.type !== "message" || !candidate.message || typeof candidate.message !== "object") continue;
		const message = candidate.message as { role?: unknown; content?: unknown };
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;

		for (const block of message.content) {
			if (!block || typeof block !== "object") continue;
			const toolCall = block as { type?: unknown; name?: unknown; arguments?: unknown };
			if (toolCall.type !== "toolCall" || typeof toolCall.name !== "string") continue;
			for (const path of extractWorktreePathsFromToolCall(toolCall.name, toolCall.arguments, worktreeRoot, home)) {
				paths.add(path);
			}
		}
	}

	return [...paths].sort();
}

export async function readWorktreeMetadata(path: string): Promise<WorktreeMetadata | undefined> {
	try {
		const gitFile = await readFile(join(path, ".git"), "utf8");
		const rawGitDir = gitFile.trim().match(/^gitdir:\s*(.+)$/)?.[1];
		if (!rawGitDir) return undefined;
		const gitDir = resolve(path, rawGitDir).replaceAll("\\", "/");
		const marker = "/.git/worktrees/";
		const markerIndex = gitDir.indexOf(marker);
		if (markerIndex < 0) return undefined;

		const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
		const branch = head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : head.slice(0, 8);
		if (!branch) return undefined;

		return {
			path,
			repo: basename(gitDir.slice(0, markerIndex)),
			branch,
			commonDir: gitDir.slice(0, markerIndex + "/.git".length),
		};
	} catch {
		return undefined;
	}
}

const ROLLUP_CHECKS: Record<string, PullRequestChecks> = {
	SUCCESS: "success",
	FAILURE: "failure",
	ERROR: "failure",
	PENDING: "pending",
	EXPECTED: "pending",
};

/** One GraphQL query covering every branch of a repository; branch names travel as variables. */
export function buildPullRequestQuery(branchCount: number): string {
	const variables = ["$owner:String!", "$name:String!"];
	const fields: string[] = [];
	for (let index = 0; index < branchCount; index++) {
		variables.push(`$b${index}:String!`);
		fields.push(
			`b${index}:pullRequests(headRefName:$b${index},first:${PR_CANDIDATES},orderBy:{field:CREATED_AT,direction:DESC})` +
				"{nodes{number state url headRefOid commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}",
		);
	}
	return `query(${variables.join(",")}){repository(owner:$owner,name:$name){${fields.join(" ")}}}`;
}

function parseCandidate(node: unknown): PullRequestCandidate[] {
	if (!node || typeof node !== "object") return [];
	const value = node as {
		number?: unknown;
		state?: unknown;
		url?: unknown;
		headRefOid?: unknown;
		commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: unknown } | null } }> };
	};
	if (typeof value.number !== "number" || typeof value.state !== "string") return [];
	const candidate: PullRequestCandidate = { number: value.number, state: value.state.toUpperCase() };
	if (typeof value.url === "string" && SAFE_URL.test(value.url)) candidate.url = value.url;
	if (typeof value.headRefOid === "string") candidate.headRefOid = value.headRefOid;
	const rollup = value.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
	const checks = typeof rollup === "string" ? ROLLUP_CHECKS[rollup] : undefined;
	if (checks) candidate.checks = checks;
	return [candidate];
}

/** Candidates per branch, in query order; undefined when the response is unusable as a whole. */
export function parsePullRequestResponse(stdout: string, branchCount: number): PullRequestCandidate[][] | undefined {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	const repository = (value as { data?: { repository?: unknown } } | null)?.data?.repository;
	if (!repository || typeof repository !== "object") return undefined;
	const result: PullRequestCandidate[][] = [];
	for (let index = 0; index < branchCount; index++) {
		const nodes = ((repository as Record<string, unknown>)[`b${index}`] as { nodes?: unknown } | undefined)?.nodes;
		if (!Array.isArray(nodes)) return undefined;
		result.push(nodes.flatMap(parseCandidate));
	}
	return result;
}

/**
 * Picks the PR describing a worktree from its branch's candidates, newest first.
 *
 * An open PR always wins. A merged or closed one only counts when it holds this
 * worktree's work — its head is checked out, or every local commit is pushed to
 * the same-named branch — because otherwise the branch name was reused and an
 * old merged PR would hide the new work.
 */
export function selectPullRequest(
	candidates: readonly PullRequestCandidate[],
	local: Pick<GitRepositoryStatus, "branch" | "ahead" | "head" | "upstream">,
): PullRequestCandidate | undefined {
	const open = candidates.find((candidate) => candidate.state === "OPEN");
	if (open) return open;
	if (local.head !== undefined) {
		const sameHead = candidates.find((candidate) => candidate.headRefOid === local.head);
		if (sameHead) return sameHead;
	}
	if (local.ahead === 0 && local.upstream?.endsWith(`/${local.branch}`)) return candidates[0];
	return undefined;
}

function pollKey(worktree: CachedWorktree): string {
	return [worktree.branch, worktree.head ?? "", worktree.ahead, worktree.upstream ?? ""].join("\n");
}

function isTerminal(worktree: SessionWorktree): boolean {
	const state = worktree.prState?.toUpperCase();
	return state === "MERGED" || state === "CLOSED";
}

function toDisplay(worktree: CachedWorktree): SessionWorktree {
	const display: SessionWorktree = {
		path: worktree.path,
		repo: worktree.repo,
		branch: worktree.branch,
		dirty: worktree.dirty,
		ahead: worktree.ahead,
		behind: worktree.behind,
	};
	if (worktree.pr !== undefined) display.pr = worktree.pr;
	if (worktree.prState !== undefined) display.prState = worktree.prState;
	if (worktree.prUrl !== undefined) display.prUrl = worktree.prUrl;
	if (worktree.prChecks !== undefined) display.prChecks = worktree.prChecks;
	return display;
}

function sameDisplay(a: CachedWorktree | undefined, b: CachedWorktree): boolean {
	return Boolean(
		a &&
			a.path === b.path &&
			a.repo === b.repo &&
			a.branch === b.branch &&
			a.dirty === b.dirty &&
			a.ahead === b.ahead &&
			a.behind === b.behind &&
			a.pr === b.pr &&
			a.prState === b.prState &&
			a.prUrl === b.prUrl &&
			a.prChecks === b.prChecks,
	);
}

export class SessionWorktreeTracker {
	private readonly trackedPaths = new Set<string>();
	private readonly cache = new Map<string, CachedWorktree>();
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly prInFlight = new Map<string, Promise<void>>();
	private readonly abortController = new AbortController();
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastActivityAt: number;
	private disposed = false;

	constructor(private readonly host: WorktreeTrackerHost) {
		this.lastActivityAt = this.now();
	}

	/** Polls PRs on a timer so CI and newly opened PRs update while the session is idle. */
	start(): void {
		if (this.timer || this.disposed) return;
		this.timer = setInterval(() => {
			this.pollPullRequests().catch(() => {});
		}, PR_POLL_TICK_MS);
		this.timer.unref?.();
	}

	getWorktrees(): SessionWorktree[] {
		return [...this.cache.values()]
			.filter((worktree) => !isTerminal(worktree))
			.map(toDisplay)
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	async seedFromEntries(entries: readonly unknown[]): Promise<void> {
		for (const path of extractWorktreePathsFromEntries(entries, this.host.worktreeRoot, this.host.home)) {
			this.trackedPaths.add(path);
		}
		await this.refresh();
	}

	async observeToolInput(toolName: string, input: unknown): Promise<void> {
		this.lastActivityAt = this.now();
		const added: string[] = [];
		for (const path of extractWorktreePathsFromToolCall(toolName, input, this.host.worktreeRoot, this.host.home)) {
			if (this.trackedPaths.has(path)) continue;
			this.trackedPaths.add(path);
			added.push(path);
		}
		if (added.length === 0) return;
		await Promise.all(added.map((path) => this.refreshPath(path)));
		await this.pollPullRequests();
	}

	async includeCurrentWorktree(cwd: string): Promise<void> {
		const result = await this.host.exec(
			"git",
			["--no-optional-locks", "-C", cwd, "rev-parse", "--show-toplevel", "--absolute-git-dir"],
			{ timeout: 2_000, signal: this.abortController.signal },
		);
		if (this.disposed || result.code !== 0) return;
		const [topLevel, gitDir] = result.stdout.trim().split(/\r?\n/);
		if (!topLevel || !gitDir?.replaceAll("\\", "/").includes("/.git/worktrees/")) return;
		const path = resolve(topLevel);
		if (!this.trackedPaths.has(path)) this.trackedPaths.add(path);
		await this.refreshPath(path);
		await this.pollPullRequests();
	}

	/** Re-reads local git state for every tracked worktree, then looks up whatever PRs are due. */
	async refresh(): Promise<void> {
		this.lastActivityAt = this.now();
		await Promise.all(
			[...this.trackedPaths].map(async (path) => {
				const existing = this.inFlight.get(path);
				if (existing) await existing;
				if (!this.disposed && this.trackedPaths.has(path)) await this.refreshPath(path);
			}),
		);
		await this.pollPullRequests();
	}

	/** One lookup per repository with anything due; nothing runs when nothing is due. */
	async pollPullRequests(): Promise<void> {
		if (this.disposed) return;
		const now = this.now();
		const due = new Set<string>();
		for (const worktree of this.cache.values()) {
			if (this.isDue(worktree, now)) due.add(worktree.commonDir);
		}
		await Promise.all([...due].map((commonDir) => this.pollRepository(commonDir)));
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.abortController.abort();
		this.trackedPaths.clear();
		this.cache.clear();
	}

	private now(): number {
		return this.host.now?.() ?? Date.now();
	}

	private isDue(worktree: CachedWorktree, now: number): boolean {
		if (worktree.prCheckedAt === 0) return true;
		const elapsed = now - worktree.prCheckedAt;
		// A new commit, push, or branch switch is exactly when a PR or its checks change.
		if (worktree.prCheckedKey !== pollKey(worktree)) return elapsed >= PR_MIN_INTERVAL_MS;
		const idle = now - this.lastActivityAt >= PR_IDLE_AFTER_MS;
		if (worktree.prFailed) return elapsed >= (idle ? PR_IDLE_INTERVAL_MS : PR_FAILURE_INTERVAL_MS);
		if (isTerminal(worktree)) return false;
		// CI is the one thing worth watching closely even while nobody is typing.
		if (worktree.pr !== undefined && worktree.prChecks === "pending") return elapsed >= PR_PENDING_INTERVAL_MS;
		if (idle) return elapsed >= PR_IDLE_INTERVAL_MS;
		return elapsed >= (worktree.pr === undefined ? PR_ABSENT_INTERVAL_MS : PR_SETTLED_INTERVAL_MS);
	}

	private pollRepository(commonDir: string): Promise<void> {
		const existing = this.prInFlight.get(commonDir);
		if (existing) return existing;
		const poll = this.pollRepositoryUncached(commonDir).finally(() => {
			if (this.prInFlight.get(commonDir) === poll) this.prInFlight.delete(commonDir);
		});
		this.prInFlight.set(commonDir, poll);
		return poll;
	}

	private async pollRepositoryUncached(commonDir: string): Promise<void> {
		const now = this.now();
		// Riding along costs one more alias in a query that is being sent anyway.
		const included = [...this.cache.values()].filter(
			(worktree) => worktree.commonDir === commonDir && (!isTerminal(worktree) || this.isDue(worktree, now)),
		);
		const first = included[0];
		if (!first) return;
		const branches = [...new Set(included.map((worktree) => worktree.branch))];
		const args = ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}"];
		branches.forEach((branch, index) => args.push("-f", `b${index}=${branch}`));
		args.push("-f", `query=${buildPullRequestQuery(branches.length)}`);

		let candidates: PullRequestCandidate[][] | undefined;
		try {
			// gh resolves {owner}/{repo} from the worktree's remotes, the same way `gh pr view` does.
			const result = await this.host.exec("gh", args, {
				cwd: first.path,
				timeout: 8_000,
				signal: this.abortController.signal,
			});
			if (result.code === 0) candidates = parsePullRequestResponse(result.stdout, branches.length);
		} catch {
			candidates = undefined;
		}
		if (this.disposed) return;

		let changed = false;
		for (const requested of included) {
			const current = this.cache.get(requested.path);
			// A branch switch mid-lookup already reset this entry; the answer is for the old branch.
			if (!current || current.branch !== requested.branch) continue;
			let next: CachedWorktree;
			if (!candidates) {
				// Keep the last known PR: a failed lookup says nothing about the PR itself.
				next = { ...current, prCheckedAt: now, prCheckedKey: pollKey(requested), prFailed: true };
			} else {
				const pr = selectPullRequest(candidates[branches.indexOf(requested.branch)] ?? [], requested);
				next = {
					...current,
					pr: pr?.number,
					prState: pr?.state,
					prUrl: pr?.url,
					prChecks: pr?.state === "OPEN" ? pr.checks : undefined,
					prCheckedAt: now,
					prCheckedKey: pollKey(requested),
					prFailed: false,
				};
			}
			if (!sameDisplay(current, next)) changed = true;
			this.cache.set(requested.path, next);
		}
		if (changed) this.host.onChange?.();
	}

	private refreshPath(path: string): Promise<void> {
		const existing = this.inFlight.get(path);
		if (existing) return existing;

		const refresh = this.refreshPathUncached(path).finally(() => {
			if (this.inFlight.get(path) === refresh) this.inFlight.delete(path);
		});
		this.inFlight.set(path, refresh);
		return refresh;
	}

	private async refreshPathUncached(path: string): Promise<void> {
		const metadata = await readWorktreeMetadata(path);
		if (this.disposed) return;
		if (!metadata) {
			const changed = this.cache.delete(path);
			this.trackedPaths.delete(path);
			if (changed) this.host.onChange?.();
			return;
		}

		const status = await readGitStatus(
			(command, args, options) => this.host.exec(command, args, options),
			path,
			this.abortController.signal,
		);
		if (this.disposed) return;
		// Read after the awaits: a PR lookup may have landed while git was running.
		const previous = this.cache.get(path);
		const branch = status?.branch ?? metadata.branch;
		const branchChanged = previous !== undefined && previous.branch !== branch;
		const kept = branchChanged ? undefined : previous;
		const next: CachedWorktree = {
			...metadata,
			branch,
			dirty: status?.dirty ?? kept?.dirty ?? false,
			ahead: status?.ahead ?? kept?.ahead ?? 0,
			behind: status?.behind ?? kept?.behind ?? 0,
			head: status ? status.head : kept?.head,
			upstream: status ? status.upstream : kept?.upstream,
			pr: kept?.pr,
			prState: kept?.prState,
			prUrl: kept?.prUrl,
			prChecks: kept?.prChecks,
			prCheckedAt: kept?.prCheckedAt ?? 0,
			prCheckedKey: kept?.prCheckedKey,
			prFailed: kept?.prFailed,
		};
		this.cache.set(path, next);
		if (!sameDisplay(previous, next)) this.host.onChange?.();
	}
}
