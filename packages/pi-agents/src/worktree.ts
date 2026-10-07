import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expandHome, realPath as real } from "./paths.js";

export interface WorktreeRequest {
	/** Repository path, absolute or relative to the session's working directory. */
	repo: string;
	/** Branch to create (or reuse) in the worktree. */
	branch: string;
	/** Remote base branch. Default: origin's default branch. */
	base?: string;
}

export interface WorktreeInfo {
	path: string;
	branch: string;
	base: string;
	repoRoot: string;
	/** False when an existing worktree for the same branch was reused. */
	created: boolean;
	/** A new worktree of a local branch that already existed: checked out as it was, not from `origin/<base>`. */
	existingBranch?: boolean;
	/** For an existing branch, how many commits of `origin/<base>` it lacks. */
	behind?: number;
}

/** How the worktree came to be, for the agent's prompt and the caller. */
export function worktreeOrigin(worktree: WorktreeInfo): string {
	if (!worktree.created) return `an existing worktree of ${worktree.repoRoot}, reused as it is`;
	if (!worktree.existingBranch) return `created from origin/${worktree.base} of ${worktree.repoRoot}`;
	const behind = worktree.behind ? `, ${worktree.behind} commit${worktree.behind === 1 ? "" : "s"} behind it` : "";
	return `a new worktree of the local branch ${worktree.branch}, which already existed in ${worktree.repoRoot}: checked out as it was, not from origin/${worktree.base}${behind}`;
}

export type Exec = (command: string, args: string[], options?: { cwd?: string; timeout?: number; signal?: AbortSignal }) => Promise<{
	stdout: string;
	stderr: string;
	code: number;
}>;

/** `feat/foo-bar` -> `feat-foo-bar`: the flat `~/repos/worktrees/<descriptor>` layout. */
export function worktreeDirName(branch: string): string {
	return branch.replace(/[\\/]+/g, "-").replace(/[^\w.-]/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Create a worktree for `request.branch` from `origin/<base>` under
 * `worktreeDir` (default: `<parent of repo>/worktrees`), or reuse one that
 * already has that branch checked out. Worktrees are never removed here: they
 * are ordinary worktrees the parent reviews and cleans up.
 */
export async function ensureWorktree(
	exec: Exec,
	request: WorktreeRequest,
	options: { cwd: string; worktreeDir?: string; signal?: AbortSignal },
): Promise<WorktreeInfo> {
	const git = async (args: string[], cwd: string, timeout = 30_000) => {
		const result = await exec("git", args, { cwd, timeout, signal: options.signal });
		return { ...result, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
	};
	const repoPath = resolve(options.cwd, expandHome(request.repo));
	if (!existsSync(repoPath)) throw new Error(`worktree.repo does not exist: ${repoPath}`);
	const top = await git(["rev-parse", "--show-toplevel"], repoPath);
	if (top.code !== 0 || !top.stdout) throw new Error(`worktree.repo is not a git repository: ${repoPath}`);
	const repoRoot = top.stdout;

	// Both names reach git argv: a leading "-" would be read as an option
	// (`--upload-pack=<cmd>` runs a command), and check-ref-format rejects
	// refspec syntax such as ":".
	const validBranch = async (name: string) =>
		Boolean(name) && !name.startsWith("-") && (await git(["check-ref-format", "--branch", name], repoRoot)).code === 0;
	const branch = request.branch.trim();
	if (!(await validBranch(branch))) throw new Error(`invalid branch name: "${request.branch}"`);

	let base = request.base?.trim().replace(/^origin\//, "");
	if (!base) {
		const head = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoRoot);
		if (head.code !== 0 || !head.stdout.startsWith("origin/")) {
			throw new Error(`cannot tell origin's default branch in ${repoRoot}; pass worktree.base`);
		}
		base = head.stdout.slice("origin/".length);
	}
	if (!(await validBranch(base))) throw new Error(`invalid base branch: "${request.base ?? base}"`);

	const root = options.worktreeDir ? resolve(expandHome(options.worktreeDir)) : join(dirname(repoRoot), "worktrees");
	const name = worktreeDirName(branch);
	if (!name) throw new Error(`invalid branch name: "${request.branch}"`);
	const path = join(root, name);

	if (existsSync(path)) {
		// A plain directory inside another checkout would answer for that checkout.
		const own = await git(["rev-parse", "--show-toplevel"], path);
		if (own.code !== 0 || real(own.stdout) !== real(path)) throw new Error(`${path} already exists and is not a worktree of ${repoRoot} on ${branch}`);
		const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], path);
		const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], path);
		const repoCommon = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoRoot);
		if (current.code === 0 && current.stdout === branch && common.code === 0 && real(common.stdout) === real(repoCommon.stdout)) {
			return { path, branch, base, repoRoot, created: false };
		}
		throw new Error(`${path} already exists and is not a worktree of ${repoRoot} on ${branch}`);
	}

	const fetched = await git(["fetch", "--quiet", "--", "origin", base], repoRoot, 120_000);
	if (fetched.code !== 0) throw new Error(`git fetch origin ${base} failed: ${fetched.stderr || fetched.stdout}`);

	const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
	const add = exists.code === 0
		? await git(["worktree", "add", path, branch], repoRoot, 120_000)
		: await git(["worktree", "add", "-b", branch, path, `origin/${base}`], repoRoot, 120_000);
	if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr || add.stdout}`);
	if (exists.code !== 0) return { path, branch, base, repoRoot, created: true };
	const count = await git(["rev-list", "--count", `${branch}..origin/${base}`], repoRoot);
	const behind = count.code === 0 ? Number(count.stdout) : undefined;
	return { path, branch, base, repoRoot, created: true, existingBranch: true, ...(behind !== undefined && Number.isFinite(behind) ? { behind } : {}) };
}
