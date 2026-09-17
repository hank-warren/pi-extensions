// A failing remote turn used to reach the daemon log as a single sentence with
// no method, no stack and no cause, because json-rpc-2.0 hands its errorListener
// a summary string *and* the failure, and only the string was logged. This
// asserts the whole shape survives, through the real JSON-lines formatter rather
// than a stubbed logger, so a formatter change cannot quietly drop it again.
import { getLogger } from "@logtape/logtape";

import { asError } from "../src/logging/error-report.ts";
import { JsonRpcConnection } from "../src/protocol/json-rpc-connection.ts";
import type { MessageTransport } from "../src/transports/message-transport.ts";
import { describe, expect, it } from "./support/vitest-compat.ts";
import { captureLogLines } from "./support/capture-log-lines.ts";

interface LoggedError {
  readonly message?: string;
  readonly name?: string;
  readonly stack?: string;
}

const loggedErrors = (
  lines: readonly Record<string, unknown>[]
): readonly LoggedError[] =>
  lines
    .map(
      (line) =>
        (line.properties as { error?: LoggedError } | undefined)?.error
    )
    .filter((error): error is LoggedError => error !== undefined);

describe("error reporting", () => {
  it("logs name, message and stack when a request handler throws", async () => {
    const lines = await captureLogLines(async () => {
      const transport: MessageTransport = {
        close: () => undefined,
        read: async function* () {
          yield '{"id":1,"method":"thread/list","params":{}}';
        },
        send: () => Promise.resolve(),
      };
      const connection = new JsonRpcConnection({
        clientId: "error-reporting-test",
        logger: getLogger(["pi-codex-app-server"]),
        transport,
      });
      // A handler that throws the way an adapter bug would, rather than a
      // protocol error the connection already reports as a JSON-RPC response.
      connection.registerRequest("thread/list", () => {
        throw new TypeError("adapter blew up reading threads");
      });
      await connection.run().catch(() => undefined);
    });

    const errors = loggedErrors(lines);
    const reported = errors.find(({ message }) =>
      message?.includes("adapter blew up reading threads")
    );
    expect(reported?.name).toBe("TypeError");
    expect(reported?.message).toContain("adapter blew up reading threads");
    // The stack is the part the old logging lost, and the only part that says
    // which line of the adapter failed.
    expect(reported?.stack).toContain("TypeError: adapter blew up reading threads");
    expect(reported?.stack).toContain("error-reporting.test.ts");
  });

  it("keeps the library's own summary alongside the failure", async () => {
    const lines = await captureLogLines(async () => {
      const logger = getLogger(["pi-codex-app-server"]);
      logger.error(asError(new RangeError("inner failure"), "library summary"), {
        clientId: "c1",
        libraryMessage: "library summary",
      });
    });
    const line = lines.find(
      (candidate) =>
        (candidate.properties as { libraryMessage?: string } | undefined)
          ?.libraryMessage === "library summary"
    );
    expect(line).toBeDefined();
    expect(loggedErrors(lines)[0]?.name).toBe("RangeError");
  });

  describe("asError", () => {
    it("passes an Error through untouched", () => {
      const failure = new TypeError("original");
      expect(asError(failure, "fallback")).toBe(failure);
    });

    it("wraps a non-Error and keeps it as the cause", () => {
      const wrapped = asError({ code: "EPIPE" }, "socket failed");
      expect(wrapped.message).toBe('socket failed: {"code":"EPIPE"}');
      expect(wrapped.cause).toStrictEqual({ code: "EPIPE" });
      expect(wrapped.stack).toContain("socket failed");
    });

    it("uses the fallback message when there is nothing to describe", () => {
      expect(asError(undefined, "nothing thrown").message).toBe("nothing thrown");
    });

    it("survives a value that cannot be serialised", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(asError(circular, "circular failure").message).toContain(
        "circular failure"
      );
    });
  });
});
