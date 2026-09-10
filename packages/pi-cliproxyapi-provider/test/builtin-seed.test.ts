import test from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import { SEED_PROVIDERS, builtinSeedCatalog, type BuiltinCatalogSource } from "../src/builtin-seed.ts";
import { hasSourceProviderMetadata } from "../src/models-dev.ts";

function fixtureModel(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "fixture",
    baseUrl: "https://fixture.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    ...overrides,
  } as Model<Api>;
}

function fixtureSource(models: Record<string, Model<Api>[]>, generatedAt = 1_700_000_000_000): BuiltinCatalogSource {
  return {
    getBuiltinProviders: () => Object.keys(models),
    getBuiltinModels: (provider) => models[provider] ?? [],
    getBuiltinModelDataGeneratedAt: () => generatedAt,
  };
}

test("seeds every catalog provider pi publishes, keyed by provider and model id", async () => {
  const { catalog, generatedAt } = await builtinSeedCatalog();
  const builtinProviders = getBuiltinProviders() as string[];

  assert.equal(typeof generatedAt, "number");
  for (const provider of SEED_PROVIDERS) {
    assert.ok(builtinProviders.includes(provider), `pi's catalog should publish ${provider}`);
    const models = getBuiltinModels(provider as BuiltinProvider);
    assert.ok(models.length > 0, `${provider} should publish models`);
    for (const model of models) {
      const seeded = catalog[`${provider}/${model.id}`];
      assert.ok(seeded, `${provider}/${model.id} should be seeded`);
      assert.equal(seeded.name, model.name);
      assert.equal(seeded.reasoning, model.reasoning);
      assert.equal(seeded.limit?.context, model.contextWindow);
      assert.equal(seeded.limit?.output, model.maxTokens);
      assert.equal(seeded.cost?.input, model.cost.input);
      assert.deepEqual(seeded.thinkingLevelMap, model.thinkingLevelMap);
    }
  }
});

test("every seeded entry carries its source provider, as matching requires", async () => {
  const { catalog } = await builtinSeedCatalog();

  assert.equal(hasSourceProviderMetadata(catalog), true);
  for (const [key, metadata] of Object.entries(catalog)) {
    assert.equal(key, metadata.id, `${key} should be keyed by its canonical id`);
    assert.equal(key.startsWith(`${metadata.sourceProvider}/`), true, `${key} should sit under its source provider`);
  }
});

test("seeds pi's finished thinking map and pricing tiers verbatim", async () => {
  const { catalog } = await builtinSeedCatalog();

  const pinned = getBuiltinModels("anthropic").find((model) => model.id === "claude-fable-5");
  assert.ok(pinned, "pi-ai's catalog should still ship claude-fable-5");
  const fable = catalog["anthropic/claude-fable-5"];
  assert.equal(fable.cost?.input, pinned.cost.input);
  assert.deepEqual(fable.thinkingLevelMap, pinned.thinkingLevelMap);
  assert.equal(fable.thinkingLevelMap?.xhigh, "xhigh");

  // models.dev's tier shape, rebuilt from pi's `inputTokensAbove` tiers.
  const luna = catalog["openai/gpt-5.6-luna"];
  const lunaCost = getBuiltinModels("openai" as BuiltinProvider).find((model) => model.id === "gpt-5.6-luna")?.cost;
  assert.deepEqual(luna.cost?.tiers, [{
    input: lunaCost?.tiers?.[0].input,
    output: lunaCost?.tiers?.[0].output,
    cache_read: lunaCost?.tiers?.[0].cacheRead,
    cache_write: lunaCost?.tiers?.[0].cacheWrite,
    tier: { type: "context", size: 272000 },
  }]);
});

test("registers Codex-only models under openai/ so CPA's openai owner matches them", async () => {
  const { catalog } = await builtinSeedCatalog(fixtureSource({
    openai: [fixtureModel("gpt-9", { name: "GPT-9 (openai)" })],
    "openai-codex": [
      fixtureModel("gpt-9", { name: "GPT-9 (codex)" }),
      fixtureModel("gpt-9-spark", { name: "GPT-9 Spark" }),
    ],
  }));

  assert.equal(catalog["openai-codex/gpt-9-spark"].sourceProvider, "openai-codex");
  const aliased = catalog["openai/gpt-9-spark"];
  assert.equal(aliased.name, "GPT-9 Spark");
  assert.equal(aliased.id, "openai/gpt-9-spark");
  assert.equal(aliased.sourceProvider, "openai");
});

test("keeps the openai entry when both openai and openai-codex publish an id", async () => {
  const { catalog } = await builtinSeedCatalog(fixtureSource({
    openai: [fixtureModel("gpt-9", { name: "GPT-9 (openai)" })],
    "openai-codex": [fixtureModel("gpt-9", { name: "GPT-9 (codex)" })],
  }));

  assert.equal(catalog["openai/gpt-9"].name, "GPT-9 (openai)");
  assert.equal(catalog["openai-codex/gpt-9"].name, "GPT-9 (codex)");
});

test("skips seed providers pi's catalog does not publish", async () => {
  const { catalog, generatedAt } = await builtinSeedCatalog(fixtureSource({
    anthropic: [fixtureModel("claude-fixture")],
  }, 42));

  assert.deepEqual(Object.keys(catalog), ["anthropic/claude-fixture"]);
  assert.equal(generatedAt, 42);
});

test("degrades to an empty seed with one warning when pi's catalog is unreadable", async () => {
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args[0]); };
  try {
    const seed = await builtinSeedCatalog({
      getBuiltinProviders: () => { throw new Error("providers/all is gone"); },
      getBuiltinModels: () => [],
      getBuiltinModelDataGeneratedAt: () => undefined,
    });

    assert.deepEqual(seed, { catalog: {}, generatedAt: undefined });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]), /built-in model catalog .* is unavailable.*providers\/all is gone/);
});
