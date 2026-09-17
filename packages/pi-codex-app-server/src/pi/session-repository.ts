import { rm, stat } from "node:fs/promises";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, SessionInfo } from "@earendil-works/pi-coding-agent";

/** The text of a user message, for the thread preview a client lists. */
const messageText = (entry: SessionEntry | undefined): string => {
  if (entry?.type !== "message" || entry.message.role !== "user") {
    return "";
  }
  const { content } = entry.message;
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
};

import type { MetadataDatabase } from "../storage/metadata-database.ts";

/**
 * Long enough to absorb a polling client, short enough that a session started
 * in a Pi TUI shows up on a phone without a visible wait.
 */
const LIST_CACHE_MS = 3000;

export class PiSessionRepository {
  readonly #database: MetadataDatabase;
  #cache?: { readonly at: number; readonly sessions: readonly SessionInfo[] };

  constructor(database: MetadataDatabase) {
    this.#database = database;
  }

  /**
   * Every session on the host, cached for a moment.
   *
   * `SessionManager.listAll()` reads and parses every session file — 494 files,
   * 347 MB here, about two seconds — and a connected ChatGPT app polls
   * `thread/list` every two seconds for as long as its list screen is open. Left
   * uncached, the daemon does nothing but re-read the session tree forever, and
   * every other request queues behind it. Writes invalidate the cache
   * explicitly, so a thread created or deleted here shows up immediately rather
   * than after the window.
   */
  async list(): Promise<readonly SessionInfo[]> {
    const cached = this.#cache;
    if (cached && Date.now() - cached.at < LIST_CACHE_MS) {
      return cached.sessions;
    }
    const sessions = await this.#listAll();
    this.#cache = { at: Date.now(), sessions };
    return sessions;
  }

  /** Drop the cached listing: something changed that a caller must see. */
  invalidate(): void {
    this.#cache = undefined;
  }

  async #listAll(): Promise<readonly SessionInfo[]> {
    const sessions = await SessionManager.listAll();
    for (const session of sessions) {
      const stored = this.#database.getThread(session.id);
      this.#database.upsertThread({
        archived: stored?.archived ?? false,
        projectId: stored?.projectId ?? null,
        sessionFile: session.path,
        threadId: session.id,
        updatedAt: session.modified.getTime(),
      });
    }
    return sessions;
  }

  /**
   * Metadata for one thread, without walking every session on the host.
   *
   * Pi only offers `listAll()`, which reads and parses every session file: 494
   * of them, 347 MB, on the machine this was written for. `thread/start` called
   * it once per new thread, so opening a thread from a phone took 2.3 s — past
   * the point where the ChatGPT app gives up and retries, which is how one
   * prompt turned into two threads. The database already knows where a thread's
   * file is, so the common case reads that one file instead, and the full scan
   * stays as the fallback for a thread the database has never seen.
   */
  async find(threadId: string): Promise<SessionInfo | undefined> {
    const known = this.#database.getThread(threadId);
    if (known) {
      const info = await this.#describe(known.sessionFile, threadId);
      if (info) {
        return info;
      }
    }
    return (await this.list()).find(({ id }) => id === threadId);
  }

  async #describe(
    sessionFile: string,
    threadId: string
  ): Promise<SessionInfo | undefined> {
    try {
      const [stats, sessionManager] = await Promise.all([
        stat(sessionFile),
        Promise.resolve(SessionManager.open(sessionFile)),
      ]);
      const branch = sessionManager.getBranch();
      const firstUserMessage = branch.find(
        (entry) =>
          entry.type === "message" && entry.message.role === "user"
      );
      return {
        allMessagesText: "",
        created: stats.birthtime,
        cwd: sessionManager.getCwd(),
        firstMessage: messageText(firstUserMessage),
        id: threadId,
        messageCount: branch.length,
        modified: stats.mtime,
        name: sessionManager.getSessionName(),
        path: sessionFile,
      };
    } catch {
      // Deleted or unreadable since the database last saw it; the caller falls
      // back to the full scan, which also prunes it.
      return undefined;
    }
  }

  async load(threadId: string): Promise<SessionManager | undefined> {
    let thread = this.#database.getThread(threadId);
    if (!thread) {
      await this.list();
      thread = this.#database.getThread(threadId);
    }
    return thread ? SessionManager.open(thread.sessionFile) : undefined;
  }

  async delete(threadId: string): Promise<boolean> {
    const thread = this.#database.getThread(threadId);
    if (!thread) {
      return false;
    }
    await rm(thread.sessionFile);
    this.#database.deleteThread(threadId);
    this.invalidate();
    return true;
  }
}
