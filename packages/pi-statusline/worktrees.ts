import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

export const PR_TTL_MS = 5 * 60_000;
export const PR_ABSENT_TTL_MS = 5_000;

export interface GitRepositoryStatus {
	branch: string;
	dirty: boolean;
	behind: number;
}

export interface SessionWorktree extends GitRepositoryStatus {
	path: string;
	repo: string;
	pr?: number;
	prState?: string;
}

interface CachedWorktree extends SessionWorktree {
	prCheckedAt: number;
}

interface WorktreeMetadata {
	path: string;
	repo: string;
	branch: string;
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
	let behind = 0;
	let dirty = false;

	for (const line of output.split(/\r?\n/)) {
		if (line.startsWith("# branch.oid ")) oid = line.slice("# branch.oid ".length).trim();
		else if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length).trim();
		else if (line.startsWith("# branch.ab ")) {
			const match = line.match(/^# branch\.ab \+\d+ -(\d+)$/);
			if (match) behind = Number.parseInt(match[1] ?? "0", 10);
		} else if (line.length > 0 && !line.startsWith("# ")) dirty = true;
	}

	if (branch === "(detached)") branch = oid && oid !== "(initial)" ? oid.slice(0, 8) : "detached";
	if (!branch || branch === "(unknown)") return undefined;
	return { branch, dirty, behind };
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
		};
	} catch {
		return undefined;
	}
}

function sameDisplay(a: CachedWorktree | undefined, b: CachedWorktree): boolean {
	return Boolean(
		a &&
			a.path === b.path &&
			a.repo === b.repo &&
			a.branch === b.branch &&
			a.dirty === b.dirty &&
			a.behind === b.behind &&
			a.pr === b.pr &&
			a.prState === b.prState,
	);
}

export class SessionWorktreeTracker {
	private readonly trackedPaths = new Set<string>();
	private readonly cache = new Map<string, CachedWorktree>();
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly abortController = new AbortController();
	private disposed = false;

	constructor(private readonly host: WorktreeTrackerHost) {}

	getWorktrees(): SessionWorktree[] {
		return [...this.cache.values()]
			.filter((worktree) => {
				const state = worktree.prState?.toUpperCase();
				return state !== "MERGED" && state !== "CLOSED";
			})
			.map(({ prCheckedAt: _prCheckedAt, ...worktree }) => worktree)
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	async seedFromEntries(entries: readonly unknown[]): Promise<void> {
		for (const path of extractWorktreePathsFromEntries(entries, this.host.worktreeRoot, this.host.home)) {
			this.trackedPaths.add(path);
		}
		await this.refresh();
	}

	async observeToolInput(toolName: string, input: unknown): Promise<void> {
		const added: string[] = [];
		for (const path of extractWorktreePathsFromToolCall(toolName, input, this.host.worktreeRoot, this.host.home)) {
			if (this.trackedPaths.has(path)) continue;
			this.trackedPaths.add(path);
			added.push(path);
		}
		await Promise.all(added.map((path) => this.refreshPath(path)));
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
	}

	async refresh(): Promise<void> {
		await Promise.all(
			[...this.trackedPaths].map(async (path) => {
				const existing = this.inFlight.get(path);
				if (existing) await existing;
				if (!this.disposed && this.trackedPaths.has(path)) await this.refreshPath(path);
			}),
		);
	}

	dispose(): void {
		this.disposed = true;
		this.abortController.abort();
		this.trackedPaths.clear();
		this.cache.clear();
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

		const previous = this.cache.get(path);
		const status = await readGitStatus(
			(command, args, options) => this.host.exec(command, args, options),
			path,
			this.abortController.signal,
		);
		if (this.disposed) return;
		const branch = status?.branch ?? metadata.branch;
		const branchChanged = previous !== undefined && previous.branch !== branch;
		let next: CachedWorktree = {
			...metadata,
			branch,
			dirty: status?.dirty ?? (branchChanged ? false : (previous?.dirty ?? false)),
			behind: status?.behind ?? (branchChanged ? 0 : (previous?.behind ?? 0)),
			pr: branchChanged ? undefined : previous?.pr,
			prState: branchChanged ? undefined : previous?.prState,
			prCheckedAt: branchChanged ? 0 : (previous?.prCheckedAt ?? 0),
		};
		if (!sameDisplay(previous, next)) {
			this.cache.set(path, next);
			this.host.onChange?.();
		}

		const now = this.host.now?.() ?? Date.now();
		const ttl = next.pr === undefined ? PR_ABSENT_TTL_MS : PR_TTL_MS;
		if (now - next.prCheckedAt < ttl) return;

		const result = await this.host.exec("gh", ["pr", "view", "--json", "number,state"], {
			cwd: path,
			timeout: 8_000,
			signal: this.abortController.signal,
		});
		if (this.disposed) return;

		if (result.code === 0) {
			try {
				const value = JSON.parse(result.stdout) as { number?: unknown; state?: unknown };
				if (typeof value.number === "number") next = { ...next, pr: value.number };
				if (typeof value.state === "string") next = { ...next, prState: value.state };
			} catch {
				// Keep the last known PR when gh returns malformed output.
			}
		}
		next = { ...next, prCheckedAt: now };
		const changed = !sameDisplay(this.cache.get(path), next);
		this.cache.set(path, next);
		if (changed) this.host.onChange?.();
	}
}
