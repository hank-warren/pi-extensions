import { envFlagEnabled, THREADS_ENV, type ClaudeStatus } from "./claude-cli.ts";
import type { ClaudeSessionManager } from "./manager.ts";

function age(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 120) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

const EXPECTED_THREAD: Record<string, string> = {
  fresh: "create",
  fork: "create",
  synth: "create",
  continue: "continue",
  "tool-results": "continue",
};

export function formatStatus(
  status: ClaudeStatus,
  manager: ClaudeSessionManager,
  env: Record<string, string | undefined>,
  now = Date.now(),
): string {
  const lines: string[] = [];
  if (!status.available) lines.push(status.detail ?? "Claude Code is not installed");
  else {
    lines.push(
      `Claude Code ${status.version ?? "(unknown version)"} at ${status.command}: ` +
        (status.loggedIn
          ? `logged in${status.plan ? ` (${status.plan})` : ""}${status.subscription ? "" : ", but not with a subscription"}`
          : "not logged in"),
    );
    if (status.detail) lines.push(status.detail);
  }
  const threads = env[THREADS_ENV] === undefined || envFlagEnabled(env[THREADS_ENV]);
  lines.push(`Message threads: ${threads ? "on (CLAUDE_CODE_TETHER_LIVE=1)" : `off (${THREADS_ENV})`}`);
  const workers = manager.workers();
  lines.push(`Live Claude Code processes: ${workers.length}`);
  for (const worker of workers) {
    lines.push(
      `  pid ${worker.pid ?? "?"} ${worker.phase}${worker.dirty ? " (diverged)" : ""} model ${worker.spec.model}` +
        `${worker.spec.effort ? ` effort ${worker.spec.effort}` : ""} session ${worker.sessionId ?? "?"} ` +
        `idle ${age(now - worker.lastUsed)}`,
    );
  }
  const turns = manager.history.slice(-5);
  if (turns.length) lines.push("Recent turns (newest last):");
  for (const turn of turns) {
    const usage = turn.usage
      ? ` in ${turn.usage.input} cacheRead ${turn.usage.cacheRead} cacheWrite ${turn.usage.cacheWrite} out ${turn.usage.output}`
      : "";
    lines.push(
      `  ${age(now - turn.at)} ago ${turn.model} via ${turn.path} (thread ${EXPECTED_THREAD[turn.path] ?? "?"})` +
        `${turn.ttftMs !== undefined ? ` TTFT ${turn.ttftMs}ms` : ""}${usage}${turn.error ? ` error: ${turn.error.slice(0, 160)}` : ""}`,
    );
  }
  return lines.join("\n");
}
