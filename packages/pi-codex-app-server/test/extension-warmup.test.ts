// The daemon loads Pi's extensions at startup so the *first* model/list a client
// sees already contains extension-provided models. Before this, a provider that
// arrives through an extension only appeared after some session had loaded
// extensions by accident, so a freshly started daemon showed a short picker and
// rejected its own models as unknown.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import type { AppServerConfig } from "../src/config/app-server-config.ts";
import { appServerLogger } from "../src/logging/app-server-logger.ts";
import { JsonRpcConnection } from "../src/protocol/json-rpc-connection.ts";
import { createAppServer } from "../src/server/create-app-server.ts";
import type { MessageTransport } from "../src/transports/message-transport.ts";
import { afterEach, describe, expect, it } from "./support/vitest-compat.ts";

const EXTENSION_PROVIDER = "warmup-extension-provider";
const EXTENSION_MODEL = "warmup-extension-model";
const temporaryDirectories: string[] = [];

const modelListResponseSchema = z.object({
  id: z.literal(2),
  result: z.object({
    data: z.array(z.object({ id: z.string() }).passthrough()),
  }),
});

// A provider that exists only because an extension registered it.
const PROVIDER_EXTENSION = `
export default function warmupExtension(pi) {
  pi.registerProvider(${JSON.stringify(EXTENSION_PROVIDER)}, {
    api: "openai-completions",
    baseUrl: "https://warmup.example.invalid/v1",
    name: "Warm-up Extension Provider",
    models: [{ id: ${JSON.stringify(EXTENSION_MODEL)} }],
  });
}
`;

const createTestConfig = async (): Promise<AppServerConfig> => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-codex-warmup-"));
  temporaryDirectories.push(directory);
  const piAgentDir = path.join(directory, "agent");
  const appServerHome = path.join(directory, "app-server");
  await mkdir(path.join(piAgentDir, "extensions"), { recursive: true });
  await mkdir(appServerHome, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(piAgentDir, "auth.json"),
      JSON.stringify({
        [EXTENSION_PROVIDER]: { key: "test-key", type: "api_key" },
      })
    ),
    writeFile(path.join(piAgentDir, "models.json"), JSON.stringify({})),
    writeFile(
      path.join(piAgentDir, "extensions", "warmup-provider.ts"),
      PROVIDER_EXTENSION
    ),
  ]);
  return {
    autoStart: false,
    hostName: "warmup-test",
    listenUrl: new URL("ws://127.0.0.1:0"),
    models: { defaultModel: "", patterns: ["*"] },
    paths: {
      database: path.join(appServerHome, "state.sqlite"),
      endpoint: path.join(appServerHome, "endpoint.json"),
      home: appServerHome,
      logs: path.join(appServerHome, "logs"),
    },
    piAgentDir,
    remoteControl: {
      baseUrl: new URL("http://127.0.0.1:3000/backend-api/"),
      enabled: false,
    },
  };
};

const firstModelListIds = async (
  config: AppServerConfig
): Promise<string[]> => {
  const appServer = await createAppServer(config);
  const sent: string[] = [];
  const transport: MessageTransport = {
    close: () => undefined,
    read: async function* () {
      yield '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"warmup-test","title":null,"version":"1"},"capabilities":null}}';
      yield '{"method":"initialized"}';
      yield '{"id":2,"method":"model/list","params":{"limit":500}}';
    },
    send: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
  };
  const connection = new JsonRpcConnection({
    clientId: "warmup-test",
    logger: appServerLogger,
    transport,
  });
  appServer.register(connection);
  try {
    await connection.run();
  } finally {
    appServer.close();
  }
  return sent
    .map((message) => modelListResponseSchema.safeParse(JSON.parse(message)))
    .filter((result) => result.success)
    .flatMap(({ data }) => data.result.data.map(({ id }) => id));
};

describe("extension warm-up", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true }))
    );
  });

  it("includes extension-registered models in the first model/list", async () => {
    const config = await createTestConfig();
    const ids = await firstModelListIds(config);
    expect(ids).toContain(`${EXTENSION_PROVIDER}/${EXTENSION_MODEL}`);
  });

  it("describes a model that has no context window instead of failing the list", async () => {
    // The extension above registers `models: [{ id }]`, so its model has no
    // contextWindow even though Pi's type says it must. model/list returns the
    // whole catalogue in one response: one such model used to throw and leave
    // the client with no models at all.
    const config = await createTestConfig();
    const appServer = await createAppServer(config);
    const { PiModelCatalog } = await import("../src/pi/model-catalog.ts");
    const { PiModelRuntime } = await import("../src/pi/pi-model-runtime.ts");
    const runtime = await PiModelRuntime.create(config);
    const listed = await new PiModelCatalog(runtime, config.models).list({ limit: 500 });
    appServer.close();

    const model = listed.data.find(
      ({ id }) => id === `${EXTENSION_PROVIDER}/${EXTENSION_MODEL}`
    );
    expect(model?.description).toContain("context window unknown");
    expect(model?.displayName).toContain(EXTENSION_MODEL);
  });

  it("resolves an extension model on a thread start that races the warm-up", async () => {
    const config = await createTestConfig();
    const { PiModelRuntime } = await import("../src/pi/pi-model-runtime.ts");
    const { PiModelCatalog } = await import("../src/pi/model-catalog.ts");
    const runtime = await PiModelRuntime.create(config);
    const catalog = new PiModelCatalog(runtime, config.models);

    // Nothing has loaded extensions yet: the plain lookup cannot see the model,
    // and the ready lookup waits for the load that makes it visible.
    expect(catalog.resolve(`${EXTENSION_PROVIDER}/${EXTENSION_MODEL}`)).toBeUndefined();
    const resolved = await catalog.resolveReady(
      `${EXTENSION_PROVIDER}/${EXTENSION_MODEL}`
    );
    expect(resolved?.id).toBe(EXTENSION_MODEL);
  });
});
