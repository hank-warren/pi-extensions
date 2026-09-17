import type { JsonRpcConnection } from "../protocol/json-rpc-connection.ts";

/**
 * Which connection currently owns each thread.
 *
 * A stdio client is one connection for its whole life, so binding a thread's
 * notifications to the connection that started the turn works there and hid this
 * for a long time. The ChatGPT relay is not like that: the app opens a fresh
 * stream — a fresh `initialize`, a fresh `JsonRpcConnection` — whenever it feels
 * like it, then calls `thread/resume` on the new one to pick the conversation
 * back up. Observed in one short phone session: three streams for one thread.
 *
 * A turn that streams to the stream it was started on therefore streams into a
 * socket the app has already abandoned, and the phone waits forever for a reply
 * that was generated, written to the session and thrown away. This keeps the
 * binding current instead, so `turn/completed` reaches whoever is listening now.
 */
export class ThreadConnections {
  readonly #byThread = new Map<string, JsonRpcConnection>();

  /** Bind a thread to the connection that most recently asked for it. */
  attach(threadId: string, connection: JsonRpcConnection): void {
    this.#byThread.set(threadId, connection);
  }

  /** The live connection for a thread, or undefined when nobody is attached. */
  get(threadId: string): JsonRpcConnection | undefined {
    const connection = this.#byThread.get(threadId);
    if (!connection) {
      return undefined;
    }
    if (connection.isClosed) {
      // The app dropped this stream without resuming elsewhere yet. Forget it
      // rather than writing into a closed transport, which used to surface as
      // "Remote client transport is closed" at ERROR for an ordinary
      // stream rotation.
      this.#byThread.delete(threadId);
      return undefined;
    }
    return connection;
  }

  /** Drop every binding for a connection that has gone away. */
  detach(connection: JsonRpcConnection): void {
    for (const [threadId, bound] of this.#byThread) {
      if (bound === connection) {
        this.#byThread.delete(threadId);
      }
    }
  }
}
