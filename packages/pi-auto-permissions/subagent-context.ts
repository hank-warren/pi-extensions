import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Runtime facts about a subagent child session, forwarded to the guardian as
 * evidence. Facts only — the guardian judges what they imply; see
 * SUBAGENT_CONTEXT_SYSTEM_PROMPT in review.ts.
 *
 * Detection is based on the environment contract of `pi-subagents`
 * (nicobailon/pi-subagents), which spawns children with `PI_SUBAGENT_CHILD=1`
 * plus run id and nesting depth. Absent that env, sessions are treated as
 * ordinary sessions and review behavior is unchanged.
 */
export interface SubagentExecutionContext {
  subagent: true;
  /** pi-subagents run id (PI_SUBAGENT_RUN_ID), when present. */
  runId?: string;
  /** Nesting depth for nested subagents (PI_SUBAGENT_DEPTH), when > 0. */
  depth?: number;
  /** True when cwd is a linked git worktree (`.git` is a gitdir pointer file). */
  isolatedWorktree: boolean;
  /** Branch checked out in cwd, when it can be read from git metadata. */
  branch?: string;
}

export function detectSubagentContext(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): SubagentExecutionContext | undefined {
  if (env.PI_SUBAGENT_CHILD !== "1") return undefined;

  const context: SubagentExecutionContext = { subagent: true, isolatedWorktree: false };
  // The run id is an attacker-influenced string that reaches the guardian
  // prompt: cap length and charset so it stays an identifier, not a payload.
  const runId = env.PI_SUBAGENT_RUN_ID?.trim().replace(/[^\w.:-]/g, "").slice(0, 128);
  if (runId) context.runId = runId;
  const depth = Number(env.PI_SUBAGENT_DEPTH ?? "");
  if (Number.isInteger(depth) && depth > 0) context.depth = depth;

  try {
    const gitPath = join(cwd, ".git");
    // A linked worktree has a `.git` pointer *file*; a primary checkout has a
    // `.git` directory. statSync throws when cwd is not a git checkout at all.
    if (!statSync(gitPath).isFile()) return context;
    const gitdirRaw = readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
    if (!gitdirRaw) return context;
    const gitdir = isAbsolute(gitdirRaw) ? gitdirRaw : join(cwd, gitdirRaw);
    // Submodule checkouts also use a `.git` pointer file, but their gitdirs
    // live under `.git/modules/<name>` inside a shared primary checkout — they
    // are not isolated. Linked-worktree gitdirs are guaranteed to live under
    // `<common>/.git/worktrees/<name>`.
    if (!/[\\/]worktrees[\\/]/.test(gitdir)) return context;
    context.isolatedWorktree = true;
    const branch = readFileSync(join(gitdir, "HEAD"), "utf8").match(/^ref:\s*refs\/heads\/(\S+)/m)?.[1];
    if (branch) context.branch = branch;
  } catch {
    // Not a git checkout or unreadable metadata: report the facts we have.
  }
  return context;
}
