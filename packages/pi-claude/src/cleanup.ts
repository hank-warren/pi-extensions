import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Claude Code sessions this extension created are deleted after this long. */
export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

function registryPath(): string {
  return join(getAgentDir(), "pi-claude", "claude-sessions.jsonl");
}

/** Remember a Claude Code session file this extension created, so it can be cleaned up later. */
export async function registerCreatedSession(projectDir: string, sessionId: string): Promise<void> {
  const path = registryPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify({ projectDir, sessionId, createdAt: Date.now() })}\n`, { mode: 0o600 });
}

/**
 * Delete registered Claude Code sessions older than the retention window. Only
 * sessions this extension created are ever touched.
 */
export async function sweepCreatedSessions(now = Date.now(), retentionMs = SESSION_RETENTION_MS): Promise<number> {
  const path = registryPath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return 0;
  }
  const keep: string[] = [];
  let removed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: { projectDir?: unknown; sessionId?: unknown; createdAt?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const { projectDir, sessionId, createdAt } = entry;
    if (typeof projectDir !== "string" || typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/u.test(sessionId)) continue;
    const file = join(projectDir, `${sessionId}.jsonl`);
    let modified = typeof createdAt === "number" ? createdAt : 0;
    try {
      modified = Math.max(modified, (await stat(file)).mtimeMs);
    } catch {
      continue; // Already gone.
    }
    if (now - modified < retentionMs) {
      keep.push(line);
      continue;
    }
    await rm(file, { force: true });
    await rm(join(projectDir, sessionId), { recursive: true, force: true });
    removed += 1;
  }
  await writeFile(path, keep.length ? `${keep.join("\n")}\n` : "", { mode: 0o600 });
  return removed;
}
