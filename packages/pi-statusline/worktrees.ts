import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pid } from "node:process";
import { type ExecResult, getAgentDir } from "@earendil-works/pi-coding-agent";

/** How often the poll timer checks whether any repository is due; a due-less tick reads and spawns nothing. */
export const PR_POLL_TICK_MS = 5_000;
/** A published branch with no PR yet. */
export const PR_ABSENT_INTERVAL_MS = 60_000;
/** A branch that exists on no remote cannot have a PR yet; it is still checked now and then for one pushed elsewhere. */
export const PR_UNPUBLISHED_INTERVAL_MS = 10 * 60_000;
/** Running checks are watched this closely while young, which is when most CI finishes. */
export const PR_PENDING_INTERVAL_MS = 20_000;
/** How long checks count as young: the usual 5-10 minute run with room to spare. */
export const PR_PENDING_FAST_FOR_MS = 15 * 60_000;
/** Checks still running past that are long or stuck, and are looked at once a minute... */
export const PR_PENDING_SLOW_INTERVAL_MS = 60_000;
/** ...until this, after which a required check that never reports cannot keep a fast poll alive. */
export const PR_PENDING_SLOW_FOR_MS = 30 * 60_000;
export const PR_PENDING_MAX_INTERVAL_MS = 5 * 60_000;
/** An open PR whose checks have settled (or that has none). */
export const PR_SETTLED_INTERVAL_MS = 5 * 60_000;
/** First retry after a failed lookup; each consecutive failure doubles it, up to the max. */
export const PR_FAILURE_INTERVAL_MS = 60_000;
export const PR_FAILURE_MAX_INTERVAL_MS = 30 * 60_000;
/** A repository gh cannot map to GitHub (no GitHub remote) is not asked again for this long. */
export const PR_UNSUPPORTED_RETRY_MS = 6 * 60 * 60_000;
/** GitHub's limits are per account, so one rate-limited answer pauses every repository on the host. */
export const PR_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
/** Absent, settled and unpublished lookups slow to this once the session has been idle for PR_IDLE_AFTER_MS. */
export const PR_IDLE_INTERVAL_MS = 10 * 60_000;
export const PR_IDLE_AFTER_MS = 10 * 60_000;
/** Past this without a turn nothing is looked up at all; the next turn or tool call resumes polling. */
export const PR_DORMANT_AFTER_MS = 60 * 60_000;
/** Floor between lookups after a push or branch switch. */
export const PR_MIN_INTERVAL_MS = 15_000;
/** After this session runs a command that changes a PR or starts CI, GitHub gets this long to register it. */
export const PR_NUDGE_DELAY_MS = 10_000;
/** A poll lock older than this belongs to a process that died mid-lookup (gh itself times out at 8 s). */
const PR_LOCK_STALE_MS = 30_000;
/** Shared answers for branches nobody has asked about in this long are dropped from the cache. */
const PR_CACHE_RETENTION_MS = 7 * 24 * 60 * 60_000;
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
	/** Commit of the same-named remote-tracking branch: a push moves it, a local commit does not. */
	remoteHead?: string;
	/** The branch exists on a remote, so a PR can exist for it. */
	published: boolean;
	/** Fetch time of the PR data held; 0 before the first answer. */
	prCheckedAt: number;
	/** Poll key the held PR data was fetched for; a different current key makes the PR due sooner. */
	prCheckedKey?: string;
	/** When the open PR's current head started reporting running checks. */
	pendingSince?: number;
	pendingRef?: string;
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
	/** Directory of the host-wide PR cache shared by every pi process; defaults under the agent dir. */
	cacheDir?: string;
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

const OBJECT_ID = /^[0-9a-f]{40,64}$/;

/**
 * Commit of `refs/remotes/<any remote>/<branch>`, read from git's ref files
 * rather than by spawning git; undefined when no remote has the branch.
 */
export async function readRemoteBranch(commonDir: string, branch: string): Promise<string | undefined> {
	const remotesDir = join(commonDir, "refs", "remotes");
	let remotes: string[] = [];
	try {
		remotes = await readdir(remotesDir);
	} catch {
		// No loose remote-tracking refs; packed-refs may still have them.
	}
	for (const remote of remotes) {
		try {
			const value = (await readFile(join(remotesDir, remote, branch), "utf8")).trim();
			if (OBJECT_ID.test(value)) return value;
		} catch {
			// Not on this remote.
		}
	}
	try {
		const packed = await readFile(join(commonDir, "packed-refs"), "utf8");
		for (const line of packed.split(/\r?\n/)) {
			const match = /^([0-9a-f]{40,64}) refs\/remotes\/[^/]+\/(.+)$/.exec(line);
			if (match?.[2] === branch) return match[1];
		}
	} catch {
		// No packed refs.
	}
	return undefined;
}

// gh subcommands that change a PR or (re)start its CI, and git push with any -C/-c options before it.
const PR_ACTION =
	/\bgh\s+(?:run\s+(?:rerun|cancel)|workflow\s+run|pr\s+(?:create|merge|ready|close|reopen))\b|\bgit\s+(?:-[Cc]\s+\S+\s+)*push\b/;

/** Whether a finished tool call changed a PR or its CI, making a prompt re-check worth one lookup. */
export function isPullRequestAction(toolName: string, input: unknown): boolean {
	const baseName = toolName.slice(toolName.lastIndexOf(".") + 1);
	if (baseName !== "bash" || !input || typeof input !== "object") return false;
	const command = (input as { command?: unknown }).command;
	return typeof command === "string" && PR_ACTION.test(stripHeredocBodies(command));
}

export type LookupFailure = "rate-limited" | "unsupported" | "failed";

/** Sorts a failed `gh` lookup by how long it is worth waiting before asking again. */
export function classifyLookupFailure(output: string): LookupFailure {
	const text = output.toLowerCase();
	if (/rate limit|abuse detection/.test(text)) return "rate-limited";
	if (/no git remotes found|none of the git remotes|known github host/.test(text)) return "unsupported";
	return "failed";
}

/** Delay before the next lookup after `failures` consecutive failures ending in `failure`. */
export function failureBackoff(failure: LookupFailure, failures: number): number {
	if (failure === "unsupported") return PR_UNSUPPORTED_RETRY_MS;
	if (failure === "rate-limited") return PR_RATE_LIMIT_BACKOFF_MS;
	return Math.min(PR_FAILURE_MAX_INTERVAL_MS, PR_FAILURE_INTERVAL_MS * 2 ** Math.max(0, failures - 1));
}

/** A push or branch switch changes this; a local commit does not, because GitHub cannot see it yet. */
function pollKey(worktree: CachedWorktree): string {
	return `${worktree.branch}\n${worktree.remoteHead ?? (worktree.published ? "published" : "")}`;
}

function isPublished(worktree: Pick<CachedWorktree, "branch" | "upstream">, remoteHead: string | undefined): boolean {
	return remoteHead !== undefined || worktree.upstream?.endsWith(`/${worktree.branch}`) === true;
}

function pollInterval(worktree: CachedWorktree, idle: boolean, now: number): number {
	if (worktree.pr !== undefined && worktree.prChecks === "pending") {
		// Age counts from the first sighting of this head's running checks, shared host-wide.
		const running = now - (worktree.pendingSince ?? now);
		if (running < PR_PENDING_FAST_FOR_MS) return PR_PENDING_INTERVAL_MS;
		return running < PR_PENDING_SLOW_FOR_MS ? PR_PENDING_SLOW_INTERVAL_MS : PR_PENDING_MAX_INTERVAL_MS;
	}
	if (idle) return PR_IDLE_INTERVAL_MS;
	if (!worktree.published) return PR_UNPUBLISHED_INTERVAL_MS;
	return worktree.pr === undefined ? PR_ABSENT_INTERVAL_MS : PR_SETTLED_INTERVAL_MS;
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

/** One branch's last answer from GitHub, shared by every pi process on the host. */
interface SharedBranch {
	fetchedAt: number;
	/** Poll key of the branch when it was fetched. */
	key: string;
	candidates: PullRequestCandidate[];
	pendingSince?: number;
	/** `number:headRefOid` of the open PR whose checks have been running since pendingSince. */
	pendingRef?: string;
}

interface SharedRepository {
	branches: Map<string, SharedBranch>;
	failures?: number;
	retryAt?: number;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseStoredCandidate(value: unknown): PullRequestCandidate[] {
	if (!value || typeof value !== "object") return [];
	const body = value as Record<string, unknown>;
	if (!isFiniteNumber(body.number) || typeof body.state !== "string") return [];
	const candidate: PullRequestCandidate = { number: body.number, state: body.state };
	if (typeof body.url === "string" && SAFE_URL.test(body.url)) candidate.url = body.url;
	if (typeof body.headRefOid === "string") candidate.headRefOid = body.headRefOid;
	if (body.checks === "pending" || body.checks === "success" || body.checks === "failure") {
		candidate.checks = body.checks;
	}
	return [candidate];
}

function parseSharedRepository(json: unknown): SharedRepository {
	const repository: SharedRepository = { branches: new Map() };
	if (!json || typeof json !== "object") return repository;
	const body = json as Record<string, unknown>;
	if (isFiniteNumber(body.failures)) repository.failures = body.failures;
	if (isFiniteNumber(body.retryAt)) repository.retryAt = body.retryAt;
	if (!body.branches || typeof body.branches !== "object") return repository;
	for (const [branch, value] of Object.entries(body.branches)) {
		if (!value || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;
		if (!isFiniteNumber(entry.fetchedAt) || typeof entry.key !== "string" || !Array.isArray(entry.candidates)) continue;
		const parsed: SharedBranch = {
			fetchedAt: entry.fetchedAt,
			key: entry.key,
			candidates: entry.candidates.flatMap(parseStoredCandidate),
		};
		if (isFiniteNumber(entry.pendingSince) && typeof entry.pendingRef === "string") {
			parsed.pendingSince = entry.pendingSince;
			parsed.pendingRef = entry.pendingRef;
		}
		repository.branches.set(branch, parsed);
	}
	return repository;
}

let writeSequence = 0;

/**
 * Host-wide PR answers, one file per repository. A busy host runs dozens of pi
 * sessions over the same repositories, and GitHub's GraphQL budget is per
 * account: without this every session would ask the same question on its own.
 * A lock file makes one process the poller for a repository at a time; the
 * others adopt its answer on a later tick.
 */
class PullRequestStore {
	constructor(private readonly dir: string) {}

	async readRepository(commonDir: string): Promise<SharedRepository> {
		try {
			return parseSharedRepository(JSON.parse(await readFile(this.path(commonDir, ".json"), "utf8")));
		} catch {
			return { branches: new Map() };
		}
	}

	writeRepository(commonDir: string, repository: SharedRepository, now: number): Promise<void> {
		const branches = Object.fromEntries(
			[...repository.branches].filter(([, entry]) => now - entry.fetchedAt < PR_CACHE_RETENTION_MS),
		);
		return this.write(this.path(commonDir, ".json"), {
			commonDir,
			branches,
			failures: repository.failures,
			retryAt: repository.retryAt,
		});
	}

	async readHostRetryAt(): Promise<number> {
		try {
			const value = (JSON.parse(await readFile(join(this.dir, "host.json"), "utf8")) as { retryAt?: unknown })
				.retryAt;
			return isFiniteNumber(value) ? value : 0;
		} catch {
			return 0;
		}
	}

	writeHostRetryAt(retryAt: number): Promise<void> {
		return this.write(join(this.dir, "host.json"), { retryAt });
	}

	/** A release function, "held" while a sibling is polling, or "unavailable" when the directory is unusable. */
	async lock(commonDir: string): Promise<(() => Promise<void>) | "held" | "unavailable"> {
		const path = this.path(commonDir, ".lock");
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await mkdir(this.dir, { recursive: true, mode: 0o700 });
				await (await open(path, "wx", 0o600)).close();
				return () => unlink(path).catch(() => {});
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "unavailable";
				try {
					if (Date.now() - (await stat(path)).mtimeMs < PR_LOCK_STALE_MS) return "held";
					await unlink(path);
				} catch {
					// Someone else removed or replaced it first; the retry settles who owns it.
				}
			}
		}
		return "held";
	}

	private path(commonDir: string, suffix: string): string {
		return join(this.dir, `${createHash("sha256").update(commonDir).digest("hex").slice(0, 16)}${suffix}`);
	}

	/** Atomic write; a lost race costs at most one extra lookup, never a corrupt file. */
	private async write(path: string, value: unknown): Promise<void> {
		const temporary = `${path}.${pid}.${++writeSequence}.tmp`;
		try {
			await mkdir(this.dir, { recursive: true, mode: 0o700 });
			await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
			await rename(temporary, path);
		} catch {
			// The cache is an optimisation; failing to share it must never surface.
			await unlink(temporary).catch(() => {});
		}
	}
}

function withPullRequest(worktree: CachedWorktree, entry: SharedBranch): CachedWorktree {
	const pr = selectPullRequest(entry.candidates, worktree);
	return {
		...worktree,
		pr: pr?.number,
		prState: pr?.state,
		prUrl: pr?.url,
		prChecks: pr?.state === "OPEN" ? pr.checks : undefined,
		prCheckedAt: entry.fetchedAt,
		prCheckedKey: entry.key,
		pendingSince: entry.pendingSince,
		pendingRef: entry.pendingRef,
	};
}

export class SessionWorktreeTracker {
	private readonly trackedPaths = new Set<string>();
	private readonly cache = new Map<string, CachedWorktree>();
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly prInFlight = new Map<string, Promise<void>>();
	/** Earliest next lookup per repository after a failure, mirrored from the shared cache. */
	private readonly retryAt = new Map<string, number>();
	/** Earliest next lookup anywhere, after GitHub rate-limited the account. */
	private hostRetryAt = 0;
	private readonly store: PullRequestStore;
	private readonly abortController = new AbortController();
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastActivityAt: number;
	/** When a PR-changing command this session ran becomes worth a look; answers fetched after it satisfy it. */
	private nudgeAt: number | undefined;
	private disposed = false;

	constructor(private readonly host: WorktreeTrackerHost) {
		this.lastActivityAt = this.now();
		this.store = new PullRequestStore(host.cacheDir ?? join(getAgentDir(), "statusline-prs"));
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

	/**
	 * Called once a tool has finished. A merge, rerun, push and the like makes every
	 * tracked repository due shortly, instead of waiting out a settled interval that
	 * could swallow a whole CI run. The poll timer picks it up, so this spawns nothing.
	 */
	observeToolResult(toolName: string, input: unknown): void {
		if (!isPullRequestAction(toolName, input)) return;
		this.lastActivityAt = this.now();
		this.nudgeAt = this.now() + PR_NUDGE_DELAY_MS;
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

	/** Looks up each repository with anything due; nothing is read or spawned when nothing is due. */
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

	private worktreesOf(commonDir: string): CachedWorktree[] {
		return [...this.cache.values()]
			.filter((worktree) => worktree.commonDir === commonDir)
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	private isDue(worktree: CachedWorktree, now: number): boolean {
		if (now < Math.max(this.hostRetryAt, this.retryAt.get(worktree.commonDir) ?? 0)) return false;
		const quiet = now - this.lastActivityAt;
		// Nobody has used this session for an hour; what it shows can wait for the next turn.
		if (quiet >= PR_DORMANT_AFTER_MS) return false;
		if (worktree.prCheckedAt === 0) return true;
		if (this.nudgeAt !== undefined && now >= this.nudgeAt && worktree.prCheckedAt < this.nudgeAt) return true;
		const elapsed = now - worktree.prCheckedAt;
		// A push or branch switch is exactly when a PR or its checks change.
		if (worktree.prCheckedKey !== pollKey(worktree)) return elapsed >= PR_MIN_INTERVAL_MS;
		if (isTerminal(worktree)) return false;
		return elapsed >= pollInterval(worktree, quiet >= PR_IDLE_AFTER_MS, now);
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
		// Ref files only: notices a push made from another session while this one sat idle.
		await this.refreshRemoteHeads(commonDir);
		// A sibling process may already have answered; adopting that costs one file read.
		let shared = await this.store.readRepository(commonDir);
		if (this.disposed || !this.adopt(commonDir, shared)) return;
		const lock = await this.store.lock(commonDir);
		// A sibling is asking right now; its answer is adopted on a later tick.
		if (lock === "held") return;
		try {
			if (lock !== "unavailable") {
				// The previous holder may have answered between our read and the lock.
				shared = await this.store.readRepository(commonDir);
				this.hostRetryAt = Math.max(this.hostRetryAt, await this.store.readHostRetryAt());
				if (this.disposed || !this.adopt(commonDir, shared)) return;
			}
			await this.lookUp(commonDir, shared);
		} finally {
			if (lock !== "unavailable") await lock();
		}
	}

	private async refreshRemoteHeads(commonDir: string): Promise<void> {
		await Promise.all(
			this.worktreesOf(commonDir).map(async (worktree) => {
				const remoteHead = await readRemoteBranch(commonDir, worktree.branch);
				const current = this.cache.get(worktree.path);
				if (!current || current.branch !== worktree.branch || current.remoteHead === remoteHead) return;
				this.cache.set(worktree.path, { ...current, remoteHead, published: isPublished(current, remoteHead) });
			}),
		);
	}

	/** Takes shared answers newer than ours for the same push; true when anything in the repository is still due. */
	private adopt(commonDir: string, shared: SharedRepository): boolean {
		if (shared.retryAt !== undefined) {
			this.retryAt.set(commonDir, Math.max(this.retryAt.get(commonDir) ?? 0, shared.retryAt));
		}
		let changed = false;
		for (const worktree of this.worktreesOf(commonDir)) {
			const entry = shared.branches.get(worktree.branch);
			if (!entry || entry.fetchedAt <= worktree.prCheckedAt || entry.key !== pollKey(worktree)) continue;
			const next = withPullRequest(worktree, entry);
			if (!sameDisplay(worktree, next)) changed = true;
			this.cache.set(worktree.path, next);
		}
		if (changed) this.host.onChange?.();
		const now = this.now();
		return this.worktreesOf(commonDir).some((worktree) => this.isDue(worktree, now));
	}

	private async lookUp(commonDir: string, shared: SharedRepository): Promise<void> {
		const now = this.now();
		// Riding along costs one more alias in a query being sent anyway, and refreshes the answer for siblings.
		const included = this.worktreesOf(commonDir).filter((worktree) => !isTerminal(worktree) || this.isDue(worktree, now));
		const first = included[0];
		if (!first) return;
		const branches = [...new Set(included.map((worktree) => worktree.branch))];
		const args = ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}"];
		branches.forEach((branch, index) => args.push("-f", `b${index}=${branch}`));
		args.push("-f", `query=${buildPullRequestQuery(branches.length)}`);

		let result: ExecResult | undefined;
		try {
			// gh resolves {owner}/{repo} from the worktree's remotes, the same way `gh pr view` does.
			result = await this.host.exec("gh", args, {
				cwd: first.path,
				timeout: 8_000,
				signal: this.abortController.signal,
			});
		} catch {
			result = undefined;
		}
		if (this.disposed) return;

		const candidates = result?.code === 0 ? parsePullRequestResponse(result.stdout, branches.length) : undefined;
		if (!candidates) {
			// Keep the last known PR: a failed lookup says nothing about the PR itself.
			const failure = classifyLookupFailure(`${result?.stderr ?? ""}\n${result?.stdout ?? ""}`);
			const failures = (shared.failures ?? 0) + 1;
			const retryAt = now + failureBackoff(failure, failures);
			this.retryAt.set(commonDir, retryAt);
			if (failure === "rate-limited") {
				this.hostRetryAt = retryAt;
				await this.store.writeHostRetryAt(retryAt);
			}
			await this.store.writeRepository(commonDir, { ...shared, failures, retryAt }, now);
			return;
		}

		this.retryAt.delete(commonDir);
		const answered = new Map(shared.branches);
		branches.forEach((branch, index) => {
			const local = included.find((worktree) => worktree.branch === branch) as CachedWorktree;
			const list = candidates[index] ?? [];
			const entry: SharedBranch = { fetchedAt: now, key: pollKey(local), candidates: list };
			const open = list.find((candidate) => candidate.state === "OPEN");
			if (open?.checks === "pending") {
				const ref = `${open.number}:${open.headRefOid ?? ""}`;
				const previous = shared.branches.get(branch);
				entry.pendingRef = ref;
				entry.pendingSince =
					previous?.pendingRef === ref
						? (previous.pendingSince ?? now)
						: local.pendingRef === ref
							? (local.pendingSince ?? now)
							: now;
			}
			answered.set(branch, entry);
		});
		await this.store.writeRepository(commonDir, { branches: answered }, now);

		let changed = false;
		for (const requested of included) {
			const current = this.cache.get(requested.path);
			// A branch switch mid-lookup already reset this entry; the answer is for the old branch.
			if (!current || current.branch !== requested.branch) continue;
			const next = withPullRequest(current, answered.get(requested.branch) as SharedBranch);
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
		const branch = status?.branch ?? metadata.branch;
		const remoteHead = await readRemoteBranch(metadata.commonDir, branch);
		if (this.disposed) return;
		// Read after the awaits: a PR lookup may have landed while git was running.
		const previous = this.cache.get(path);
		const branchChanged = previous !== undefined && previous.branch !== branch;
		const kept = branchChanged ? undefined : previous;
		const upstream = status ? status.upstream : kept?.upstream;
		const next: CachedWorktree = {
			...metadata,
			branch,
			dirty: status?.dirty ?? kept?.dirty ?? false,
			ahead: status?.ahead ?? kept?.ahead ?? 0,
			behind: status?.behind ?? kept?.behind ?? 0,
			head: status ? status.head : kept?.head,
			upstream,
			remoteHead,
			published: isPublished({ branch, upstream }, remoteHead),
			pr: kept?.pr,
			prState: kept?.prState,
			prUrl: kept?.prUrl,
			prChecks: kept?.prChecks,
			prCheckedAt: kept?.prCheckedAt ?? 0,
			prCheckedKey: kept?.prCheckedKey,
			pendingSince: kept?.pendingSince,
			pendingRef: kept?.pendingRef,
		};
		this.cache.set(path, next);
		if (!sameDisplay(previous, next)) this.host.onChange?.();
	}
}
