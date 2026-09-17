// Guards the decision in docs/adr/0021-stay-on-the-0.149-protocol-snapshot.md:
// clients newer than the vendored snapshot keep working, because the fields they
// add are accepted and the methods they add are answered as "not implemented"
// rather than "your request is malformed".
import { JSONRPCErrorCode } from "json-rpc-2.0";

import { CodexClientMethodNames } from "../src/protocol/generated/codex-methods.ts";
import {
  ProtocolValidationError,
  parseClientRequest,
} from "../src/protocol/validation.ts";
import type { CodexWireMessage } from "../src/protocol/validation.ts";
import { describe, expect, it } from "./support/vitest-compat.ts";

// Fields Codex 0.154 added to methods this server implements. Every one is
// optional there, and the schemars-generated params objects are open, so the
// 0.149 schemas must accept them.
const CODEX_0154_TURN_START = {
  id: 1,
  method: "turn/start",
  params: {
    threadId: "th_forward_compat",
    input: [{ type: "text", text: "hello" }],
    turnTrigger: "user",
    serviceTierForTurn: "default",
    cyberAccessProgram: null,
    toolOutput: null,
  },
} as const;

const CODEX_0154_THREAD_LIST = {
  id: 2,
  method: "thread/list",
  params: { originators: ["codex_cli_rs"] },
} as const;

// Methods Codex 0.154 added that the vendored snapshot has never heard of.
const CODEX_0154_ONLY_METHODS = [
  "thread/timeline/list",
  "turn/settings/update",
  "plugin/reconcile",
  "userVerification/status",
];

describe("protocol forward compatibility", () => {
  it("accepts request fields added after the vendored snapshot", () => {
    for (const message of [CODEX_0154_TURN_START, CODEX_0154_THREAD_LIST]) {
      const request = parseClientRequest(message as unknown as CodexWireMessage);
      expect(request.method).toBe(message.method);
    }
  });

  it("does not recognise methods added after the vendored snapshot", () => {
    // The connection turns exactly this rejection into -32601 rather than
    // -32602; if a re-vendor ever makes these known, that mapping and this
    // expectation both need revisiting.
    for (const method of CODEX_0154_ONLY_METHODS) {
      expect(CodexClientMethodNames as readonly string[]).not.toContain(method);
      expect(() =>
        parseClientRequest({
          id: 3,
          method,
          params: { threadId: "th_forward_compat" },
        } as unknown as CodexWireMessage)
      ).toThrow(ProtocolValidationError);
    }
  });

  it("answers an unknown method with MethodNotFound, not InvalidParams", async () => {
    const { JsonRpcConnection } = await import(
      "../src/protocol/json-rpc-connection.ts"
    );
    const sent: string[] = [];
    let release: (() => void) | undefined;
    const transport = {
      close: () => release?.(),
      read: async function* () {
        yield JSON.stringify({
          id: 7,
          method: "thread/timeline/list",
          params: { threadId: "th_forward_compat" },
        });
        yield JSON.stringify({
          id: 8,
          method: "thread/start",
          params: { cwd: 42 },
        });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      send: async (payload: string) => {
        sent.push(payload);
      },
    };
    const logged: string[] = [];
    const logger = {
      debug: (message: string) => logged.push(message),
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    };
    const connection = new JsonRpcConnection({
      clientId: "test-client",
      logger: logger as never,
      transport: transport as never,
    });
    const running = connection.run();
    // Both messages are consumed before the generator parks on `release`.
    while (sent.length < 2) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    connection.close();
    await running.catch(() => undefined);

    const [unknownMethod, badParams] = sent.map(
      (payload) => JSON.parse(payload) as { error: { code: number; message: string } }
    );
    expect(unknownMethod.error.code).toBe(JSONRPCErrorCode.MethodNotFound);
    expect(unknownMethod.error.message).toContain("thread/timeline/list");
    expect(badParams.error.code).toBe(JSONRPCErrorCode.InvalidParams);
    expect(logged).toContainEqual(
      "Codex client requested a method outside the vendored protocol snapshot"
    );
  });
});
