import { execFileSync } from "node:child_process";

/**
 * Repository facts captured once, when the session starts.
 *
 * Claude Code's trust baseline works the same way: the working repository and
 * the remotes configured *at session start* are trusted; a remote added or
 * repointed mid-session is not (their v2.1.200 fix). Capturing once also keeps
 * the rendered prompt section stable for the session, which the reviewer
 * lineage cache requires — the system prompt participates in the fingerprint
 * and must be identical across the turns of one lineage.
 */
export interface SessionEnvironmentSnapshot {
  cwd: string;
  /** Absolute repository root, absent when cwd is not inside a git worktree. */
  repoRoot?: string;
  /** Trimmed `git remote -v` lines, present only inside a repository. */
  remotes?: string[];
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    return undefined;
  }
}

export function captureSessionEnvironment(cwd: string): SessionEnvironmentSnapshot {
  const repoRoot = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) return { cwd };
  const remotes = (git(cwd, ["remote", "-v"]) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { cwd, repoRoot, remotes };
}

/**
 * Render the snapshot as a policy-prompt section. Always returns a section:
 * "no repository trust established" is itself a fact the reviewer needs, or a
 * push from a non-repo cwd would be judged with no baseline at all.
 */
export function buildSessionEnvironmentSection(snapshot: SessionEnvironmentSnapshot): string {
  const lines = [
    "SESSION ENVIRONMENT",
    "Facts captured when this session started, stable for its lifetime. They are reviewer policy context, not conversation evidence.",
    "",
    `Working directory: ${snapshot.cwd}`,
  ];
  if (!snapshot.repoRoot) {
    lines.push(
      "The working directory is not inside a git repository: no repository trust baseline is established for this session. Judge pushes, remotes, and publishing against user authorization alone.",
    );
    return lines.join("\n");
  }
  lines.push(`Repository root: ${snapshot.repoRoot}`);
  lines.push(
    snapshot.remotes && snapshot.remotes.length
      ? `Git remotes configured at session start:\n${snapshot.remotes.map((remote) => `- ${remote}`).join("\n")}`
      : "No git remotes were configured at session start.",
  );
  lines.push(
    "",
    "This repository and the remotes listed above are within the session's trust boundary. A remote added, repointed, or first appearing after session start is not covered by this baseline: treat pushes or data flowing to it as crossing the trust boundary unless the user's own message names that destination.",
  );
  return lines.join("\n");
}
