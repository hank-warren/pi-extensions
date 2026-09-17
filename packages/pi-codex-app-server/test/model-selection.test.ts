// Codex clients render one flat picker, so this fork scopes the catalogue to
// CLIProxyAPI and picks the default itself, and it never rejects a model slug:
// the ChatGPT app's background helper starts threads with bare Codex slugs like
// `gpt-5.4-mini`, which used to fail with "Unknown Pi model".
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AppServerConfig, ModelSelection } from "../src/config/app-server-config.ts";
import { loadConfig } from "../src/config/app-server-config.ts";
import { PiModelCatalog } from "../src/pi/model-catalog.ts";
import { PiModelRuntime } from "../src/pi/pi-model-runtime.ts";
import { afterEach, describe, expect, it } from "./support/vitest-compat.ts";

const CPA_PROVIDER = "cpa";
const OTHER_PROVIDER = "some-other-provider";
const OPUS = "claude-opus-5";
const HAIKU = "claude-3-5-haiku";
const PINNED_PLUS = "plus/gpt-5.5";
const PINNED_TEAM = "team/gpt-5.6-luna";
const temporaryDirectories: string[] = [];

// Two providers, both configured, standing in for "CPA plus everything else Pi
// knows about". Filtering has to remove the second one.
const modelConfiguration = {
  providers: {
    [CPA_PROVIDER]: {
      api: "openai-completions",
      baseUrl: "https://cpa.example.invalid/v1",
      models: [
        { id: OPUS, contextWindow: 200_000 },
        { id: HAIKU, contextWindow: 200_000 },
        // CLIProxyAPI's account-pinned aliases: same provider, but the id names
        // an account. On the wire the key is `cpa/plus%2Fgpt-5.5`.
        { id: PINNED_PLUS, contextWindow: 272_000 },
        { id: PINNED_TEAM, contextWindow: 272_000 },
      ],
      name: "CLIProxyAPI",
    },
    [OTHER_PROVIDER]: {
      api: "openai-completions",
      baseUrl: "https://other.example.invalid/v1",
      models: [{ id: "some-other-model", contextWindow: 128_000 }],
      name: "Some Other Provider",
    },
  },
};

const createConfig = async (models: ModelSelection): Promise<AppServerConfig> => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-codex-selection-"));
  temporaryDirectories.push(directory);
  const piAgentDir = path.join(directory, "agent");
  await mkdir(piAgentDir, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(piAgentDir, "auth.json"),
      JSON.stringify({
        [CPA_PROVIDER]: { key: "test-key", type: "api_key" },
        [OTHER_PROVIDER]: { key: "test-key", type: "api_key" },
      })
    ),
    writeFile(
      path.join(piAgentDir, "models.json"),
      JSON.stringify(modelConfiguration)
    ),
  ]);
  return {
    autoStart: false,
    hostName: "selection-test",
    listenUrl: new URL("ws://127.0.0.1:0"),
    models,
    paths: {
      database: path.join(directory, "state.sqlite"),
      endpoint: path.join(directory, "endpoint.json"),
      home: directory,
      logs: path.join(directory, "logs"),
    },
    piAgentDir,
    remoteControl: {
      baseUrl: new URL("http://127.0.0.1:3000/backend-api/"),
      enabled: false,
    },
  };
};

const createCatalog = async (models: ModelSelection): Promise<PiModelCatalog> => {
  const config = await createConfig(models);
  return new PiModelCatalog(await PiModelRuntime.create(config), models);
};

const withEnvironment = async (
  overrides: Record<string, string | undefined>,
  run: () => void
): Promise<void> => {
  const saved = new Map(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

describe("model selection", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true }))
    );
  });

  it("defaults to CPA models only, with cpa/claude-opus-5 as the default", async () => {
    await withEnvironment(
      {
        PI_CODEX_APP_SERVER_MODELS: undefined,
        PI_CODEX_APP_SERVER_DEFAULT_MODEL: undefined,
      },
      () => {
        const { models } = loadConfig();
        expect(models.patterns).toStrictEqual(["cpa/*"]);
        expect(models.defaultModel).toBe("cpa/claude-opus-5");
      }
    );
  });

  it("reads the glob and the default model from the environment", async () => {
    await withEnvironment(
      {
        PI_CODEX_APP_SERVER_MODELS: "cpa/*, anthropic/*",
        PI_CODEX_APP_SERVER_DEFAULT_MODEL: "anthropic/claude-sonnet-5",
      },
      () => {
        const { models } = loadConfig();
        expect(models.patterns).toStrictEqual(["cpa/*", "anthropic/*"]);
        expect(models.defaultModel).toBe("anthropic/claude-sonnet-5");
      }
    );
  });

  it("offers only models matching the glob, and marks the configured default", async () => {
    const catalog = await createCatalog({
      defaultModel: `${CPA_PROVIDER}/${OPUS}`,
      patterns: [`${CPA_PROVIDER}/*`],
    });
    const listed = await catalog.list({ limit: 500 });
    const ids = listed.data.map(({ id }) => id);

    expect(ids).toContain(`${CPA_PROVIDER}/${OPUS}`);
    expect(ids).toContain(`${CPA_PROVIDER}/${HAIKU}`);
    expect(ids).not.toContain(`${OTHER_PROVIDER}/some-other-model`);
    expect(listed.data.filter(({ isDefault }) => isDefault).map(({ id }) => id)).toStrictEqual([
      `${CPA_PROVIDER}/${OPUS}`,
    ]);
  });

  it("falls back to the default model for a bare Codex slug and an unknown model", async () => {
    const catalog = await createCatalog({
      defaultModel: `${CPA_PROVIDER}/${OPUS}`,
      patterns: [`${CPA_PROVIDER}/*`],
    });

    // The two shapes seen from the ChatGPT app: a bare Codex slug with no
    // provider, and a well-formed key for a model this server does not have.
    for (const requested of ["gpt-5.4-mini", "openai/gpt-5.4-mini", "cpa/not-a-real-model"]) {
      const model = await catalog.resolveReady(requested);
      expect(model?.id).toBe(OPUS);
    }
    expect((await catalog.resolveReady(undefined))?.id).toBe(OPUS);
  });

  it("does not offer a model the glob excludes, even when asked for by key", async () => {
    const catalog = await createCatalog({
      defaultModel: `${CPA_PROVIDER}/${OPUS}`,
      patterns: [`${CPA_PROVIDER}/*`],
    });
    // CPA owns account round-robin and quota failover. A picker that offered an
    // account-pinned slug would let a client take that decision away from it, so
    // an excluded model resolves to the default rather than being honoured.
    const model = await catalog.resolveReady(`${OTHER_PROVIDER}/some-other-model`);
    expect(model?.id).toBe(OPUS);
  });

  it("excludes CPA's account-pinned aliases, because CPA picks the account", async () => {
    const catalog = await createCatalog({
      defaultModel: `${CPA_PROVIDER}/${OPUS}`,
      patterns: [`${CPA_PROVIDER}/*`],
    });
    const ids = (await catalog.list({ limit: 500 })).data.map(({ id }) => id);

    // `*` stops at a slash, so a pinned id is a two-segment name that `cpa/*`
    // cannot match, even though it lives in the same provider.
    expect(ids).toContain(`${CPA_PROVIDER}/${OPUS}`);
    expect(ids.some((id) => id.includes("plus%2F") || id.includes("team%2F"))).toBe(false);
    // And asking for one by key still lands on the default rather than pinning.
    expect((await catalog.resolveReady(`${CPA_PROVIDER}/plus%2Fgpt-5.5`))?.id).toBe(OPUS);
  });

  it("offers the pinned aliases when they are asked for deliberately", async () => {
    const pinned = await createCatalog({
      defaultModel: `${CPA_PROVIDER}/${PINNED_PLUS}`,
      patterns: [`${CPA_PROVIDER}/plus/*`],
    });
    const pinnedIds = (await pinned.list({ limit: 500 })).data.map(({ id }) => id);
    expect(pinnedIds).toStrictEqual([`${CPA_PROVIDER}/plus%2Fgpt-5.5`]);

    const everything = await createCatalog({
      defaultModel: `${CPA_PROVIDER}/${OPUS}`,
      patterns: [`${CPA_PROVIDER}/**`],
    });
    const allIds = (await everything.list({ limit: 500 })).data.map(({ id }) => id);
    expect(allIds).toContain(`${CPA_PROVIDER}/${PINNED_TEAM.replace("/", "%2F")}`);
    expect(allIds).toContain(`${CPA_PROVIDER}/${OPUS}`);
  });

  it("keeps the catalogue rather than emptying it when the glob matches nothing", async () => {
    const catalog = await createCatalog({
      defaultModel: "nothing/at-all",
      patterns: ["nothing/*"],
    });
    const listed = await catalog.list({ limit: 500 });
    // An empty picker leaves a phone unable to start any turn at all; a visibly
    // wrong catalogue is the lesser failure and shows the misconfiguration.
    expect(listed.data.length).toBeGreaterThan(0);
  });
});
