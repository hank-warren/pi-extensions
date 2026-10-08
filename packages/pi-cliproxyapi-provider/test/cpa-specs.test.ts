import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ProviderCatalog } from "../src/catalog.ts";
import {
  fetchCpaModelSpecs,
  modelSpecsEndpoint,
  parseCpaModelSpecs,
  parseCpaModelsCache,
  withCpaModelSpecs,
  type CpaModel,
} from "../src/cpa.ts";
import { cpaModelsCachePath } from "../src/discovery.ts";
import { writeCache } from "../src/cache.ts";
import type { CpaProviderConfig } from "../src/types.ts";

/** Entries shaped like CLIProxyAPI v8.0.20's `GET /v1/models?client_version=` catalog. */
const codexCatalog = {
  models: [
    {
      slug: "devin/claude-opus-5-5",
      display_name: "Claude Opus 5.5 (Devin)",
      context_window: 1000000,
      max_context_window: 1000000,
      max_tokens: 64000,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [{ effort: "low" }, { effort: "MEDIUM" }, { effort: "max" }],
      base_instructions: "large template prompt, ignored",
    },
    // A Codex template model: CPA's window is the template's, its ceiling separate.
    { slug: "team/gpt-6-sol", context_window: 272000, max_context_window: 872000, max_tokens: 128000 },
    // No max_tokens: CPA's registry knows nothing, every limit is template filler.
    { slug: "gpt-image-2", context_window: 272000, max_context_window: 272000, supported_reasoning_levels: [{ effort: "low" }] },
    { context_window: 1, max_tokens: 1 },
  ],
};

test("builds the spec catalog URL from the discovery base URL", () => {
  assert.equal(modelSpecsEndpoint("http://localhost:8317/v1/"), "http://localhost:8317/v1/models?client_version=");
});

test("reads CPA's own limits and keeps no entry whose limits are template filler", () => {
  const specs = parseCpaModelSpecs(codexCatalog);

  assert.deepEqual([...specs.keys()].sort(), ["devin/claude-opus-5-5", "team/gpt-6-sol"]);
  assert.deepEqual(specs.get("devin/claude-opus-5-5"), {
    displayName: "Claude Opus 5.5 (Devin)",
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 64000,
    reasoningLevels: ["low", "medium", "max"],
    inputModalities: ["text", "image"],
  });
  assert.deepEqual(specs.get("team/gpt-6-sol"), { contextWindow: 272000, maxContextWindow: 872000, maxTokens: 128000 });
});

test("a server that ignores the query and returns the plain list yields no specs", () => {
  assert.equal(parseCpaModelSpecs({ object: "list", data: [{ id: "gpt-5.5" }] }).size, 0);
  assert.equal(parseCpaModelSpecs(null).size, 0);
});

test("attaches specs by id and replaces, never merges, a model's previous spec", () => {
  const models: CpaModel[] = [
    { id: "devin/claude-opus-5-5", owned_by: "anthropic", spec: { maxTokens: 1 } },
    { id: "gpt-image-2", owned_by: "openai", spec: { maxTokens: 1 } },
  ];
  const attached = withCpaModelSpecs(models, parseCpaModelSpecs(codexCatalog));

  assert.equal(attached[0].spec?.maxTokens, 64000);
  assert.equal(attached[1].spec, undefined);
});

test("the CPA snapshot round-trips specs and still loads one written before specs existed", () => {
  const parsed = parseCpaModelsCache([
    { id: "a", owned_by: "openai" },
    { id: "b", owned_by: "anthropic", spec: { contextWindow: 1000000, maxTokens: 64000, reasoningLevels: ["low"], junk: 1 } },
    { id: "c", spec: { contextWindow: -1, maxTokens: "big" } },
  ]);

  assert.equal(parsed[0].spec, undefined);
  assert.deepEqual(parsed[1].spec, { contextWindow: 1000000, maxTokens: 64000, reasoningLevels: ["low"] });
  assert.equal(parsed[2].spec, undefined);
});

test("aborts a stalled spec fetch on its own budget", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  })) as typeof fetch;
  try {
    await assert.rejects(() => fetchCpaModelSpecs("http://localhost:8317/v1", {}, 1), /timed out after 1ms/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const config: CpaProviderConfig = {
  providerName: "cpa-specs-test",
  baseUrl: "http://cliproxyapi.test/v1",
  authRequired: false,
  authHeader: false,
  headers: {},
  modelsDevEnabled: false,
  metadataFallbackProvider: null,
  modelAliases: {},
  modelOverrides: {},
};

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const scratchHome = process.env.HOME!;
  const home = await mkdtemp(join(scratchHome, "pi-cpa-specs-"));
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    process.env.HOME = scratchHome;
    await rm(home, { recursive: true, force: true });
  }
}

function stubFetch(specs: (url: string) => Response): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes("client_version")) return specs(String(url));
    return new Response(JSON.stringify({ data: [{ id: "devin/claude-opus-5-5", owned_by: "anthropic" }] }), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("a refresh publishes CPA's limits for each discovered model", async () => {
  await withTempHome(async () => {
    const instance = new ProviderCatalog({ config, gpt56ContextWindow: "canonical", getApiKey: async () => undefined });
    await instance.load();
    const restore = stubFetch(() => new Response(JSON.stringify(codexCatalog), { status: 200 }));
    try {
      const result = await instance.refresh("models", "manual");
      const model = result.snapshot.built.models[0];
      assert.equal(model.maxTokens, 64000);
      assert.equal(model.contextWindow, 1000000);
      assert.equal(model.name, "Claude Opus 5.5 (Devin)");
      assert.equal(result.snapshot.built.stats.cpaSpecs, 1);
      assert.equal(result.models.specError, undefined);
    } finally {
      restore();
    }
  });
});

test("a failed spec fetch still updates the model list and keeps last-known-good limits", async () => {
  await withTempHome(async () => {
    await writeCache(cpaModelsCachePath(config), [
      { id: "devin/claude-opus-5-5", owned_by: "anthropic", spec: { contextWindow: 1000000, maxTokens: 64000 } },
    ]);
    const instance = new ProviderCatalog({ config, gpt56ContextWindow: "canonical", getApiKey: async () => undefined });
    await instance.load();
    const restore = stubFetch(() => new Response("upstream down", { status: 503 }));
    try {
      const result = await instance.refresh("models", "manual");
      assert.equal(result.models.updated, true);
      assert.match(String(result.models.specError), /HTTP 503/);
      assert.equal(result.snapshot.built.models[0].maxTokens, 64000);
      assert.equal(result.snapshot.cpaModels[0].spec?.contextWindow, 1000000);
    } finally {
      restore();
    }
  });
});
