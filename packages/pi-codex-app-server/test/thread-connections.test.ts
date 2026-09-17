// The ChatGPT app opens a fresh stream whenever it likes and calls
// thread/resume on the new one. A turn bound to the stream it started on
// therefore streams into an abandoned socket, and the phone waits forever for a
// reply that was generated and written to the session. Observed live: three
// streams for one thread inside four minutes, and an ERROR reading
// "Remote client transport is closed".
import { ThreadConnections } from "../src/pi/thread-connections.ts";
import type { JsonRpcConnection } from "../src/protocol/json-rpc-connection.ts";
import { describe, expect, it } from "./support/vitest-compat.ts";

const fakeConnection = (): JsonRpcConnection & { closed: boolean } => {
  const connection = {
    closed: false,
    get isClosed() {
      return connection.closed;
    },
  };
  return connection as unknown as JsonRpcConnection & { closed: boolean };
};

describe("thread connections", () => {
  it("routes a thread to the stream that most recently attached", () => {
    const connections = new ThreadConnections();
    const first = fakeConnection();
    const second = fakeConnection();

    connections.attach("thread-1", first);
    expect(connections.get("thread-1")).toBe(first);

    // The app rotated streams and resumed the thread on the new one.
    connections.attach("thread-1", second);
    expect(connections.get("thread-1")).toBe(second);
  });

  it("forgets a closed stream instead of writing into it", () => {
    const connections = new ThreadConnections();
    const connection = fakeConnection();
    connections.attach("thread-1", connection);

    connection.closed = true;
    expect(connections.get("thread-1")).toBeUndefined();
  });

  it("drops every binding for a connection that goes away", () => {
    const connections = new ThreadConnections();
    const gone = fakeConnection();
    const live = fakeConnection();
    connections.attach("thread-1", gone);
    connections.attach("thread-2", gone);
    connections.attach("thread-3", live);

    connections.detach(gone);

    expect(connections.get("thread-1")).toBeUndefined();
    expect(connections.get("thread-2")).toBeUndefined();
    expect(connections.get("thread-3")).toBe(live);
  });

  it("reports no connection for a thread nobody attached", () => {
    expect(new ThreadConnections().get("thread-unknown")).toBeUndefined();
  });
});
