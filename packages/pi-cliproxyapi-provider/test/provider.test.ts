import test from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildProviderModels, PI_MODEL_DEFAULTS } from "../src/provider.ts";
import { loadPiModelProfiles, NO_PI_PROFILES } from "../src/pi-profiles.ts";
import type { CpaModel } from "../src/cpa.ts";
import type { ModelsDevCatalog } from "../src/types.ts";

const cpaModels: CpaModel[] = [
  { id: "gpt-5.5", object: "model", owned_by: "openai", created: 1776902400 },
  { id: "claude-opus-4-6-thinking", object: "model", owned_by: "antigravity" },
  { id: "unknown-local", object: "model", owned_by: "feedmob-litellm" }
];

/** Every `claude*` id served by the live CLIProxyAPI catalog. */
export const CLAUDE_CATALOG_IDS = [
  "claude-3-5-haiku-20241022",
  "claude-3-7-sonnet-20250219",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  "claude-opus-4-5-20251101",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
];

const catalog = {
  "openai/gpt-5.5": {
    id: "openai/gpt-5.5",
    name: "GPT-5.5",
    reasoning: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 1050000, output: 128000 },
    cost: { input: 3, output: 18, cache_read: 0.3, cache_write: 3 }
  },
  "anthropic/claude-opus-4-6": {
    id: "anthropic/claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1000000, output: 128000 },
    cost: { input: 5, output: 25 }
  }
};

test("enriches matched models but preserves CPA model IDs", () => {
  const result = buildProviderModels(cpaModels, catalog, {
    "claude-opus-4-6-thinking": "anthropic/claude-opus-4-6"
  });

  assert.equal(result.models[0].id, "gpt-5.5");
  assert.equal(result.models[0].name, "GPT-5.5");
  assert.deepEqual(result.models[0].input, ["text", "image"]);
  // GPT-5.5 is Codex-served, so it keeps the canonical window even without pi's profile.
  assert.equal(result.models[0].contextWindow, 272000);
  assert.equal(result.models[1].id, "claude-opus-4-6-thinking");
  assert.equal(result.models[1].name, "Claude Opus 4.6");
  assert.equal(result.stats.enriched, 2);
});

test("uses explicit pi defaults for unmatched dynamic models", () => {
  const result = buildProviderModels([cpaModels[2]], catalog, {});

  assert.deepEqual(result.models[0], {
    id: "unknown-local",
    name: "unknown-local",
    ...PI_MODEL_DEFAULTS
  });
  assert.equal(result.stats.unmatched, 1);
});

test("does not share mutable default objects between fallback models", () => {
  const result = buildProviderModels([{ id: "a" }, { id: "b" }], {}, {});

  result.models[0].input.push("image");
  result.models[0].cost.input = 99;

  assert.deepEqual(result.models[1].input, ["text"]);
  assert.equal(result.models[1].cost.input, 0);
});

test("adds the fallback thinking map to every GPT-5.6 model family member", () => {
  // CLIProxyAPI's Codex route rejects `minimal` for GPT-5.6, so it maps up to low.
  const expectedThinkingLevelMap = {
    off: "none",
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  };
  const result = buildProviderModels([
    { id: "gpt-5.6-luna" },
    { id: "0xdev/gpt-5.6-sol" },
    { id: "gpt-5.6-terra" },
  ], catalog, {});

  for (const model of result.models) {
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.thinkingLevelMap, expectedThinkingLevelMap);
  }
});

test("routes GPT-5.6 family models through the Responses API", () => {
  const result = buildProviderModels([
    { id: "gpt-5.6" },
    { id: "gpt-5.6-codex" },
    { id: "0xdev/gpt-5.6-codex-mini" },
    { id: "gpt-5.60" },
    { id: "gemini-3-pro" },
  ], {}, {});

  assert.deepEqual(result.models.map((model) => model.api), [
    "openai-responses",
    "openai-responses",
    "openai-responses",
    undefined,
    undefined,
  ]);
});

test("routes GPT-6 Astra through the Responses API with its own thinking map", () => {
  const expectedThinkingLevelMap = {
    off: null,
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  };
  const result = buildProviderModels([
    { id: "gpt-6-astra", owned_by: "openai" },
    { id: "0xdev/gpt-6-astra" },
    { id: "gpt-6.1-nova" },
  ], {}, {});

  for (const model of result.models) {
    assert.equal(model.api, "openai-responses", `${model.id} should use openai-responses`);
    assert.equal(model.reasoning, true, `${model.id} should support reasoning`);
    assert.deepEqual(model.thinkingLevelMap, expectedThinkingLevelMap, `${model.id} thinking map`);
    assert.equal(model.contextWindow, 272000, `${model.id} should use the canonical Codex context window`);
  }
});

test("does not treat GPT-6 look-alikes as the GPT-6 family", () => {
  const result = buildProviderModels([
    { id: "gpt-60" },
    { id: "gpt-6x" },
    { id: "chatgpt-6-astra" },
  ], {}, {});

  for (const model of result.models) {
    assert.equal(model.api, undefined, `${model.id} should not carry an API override`);
    assert.equal(model.thinkingLevelMap, undefined, `${model.id} should not carry a thinking map`);
  }
});

test("keeps GPT-6 Astra on the canonical context window unless the setting opts in", () => {
  const astraCatalog = {
    "openai/gpt-6-astra": {
      id: "openai/gpt-6-astra",
      name: "GPT-6 Astra",
      reasoning: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 1050000, output: 128000 },
      cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
    },
  };
  const cpaModel = { id: "gpt-6-astra", owned_by: "openai" };

  const canonical = buildProviderModels([cpaModel], astraCatalog, {});
  assert.equal(canonical.stats.enriched, 1);
  assert.equal(canonical.models[0].name, "GPT-6 Astra");
  assert.deepEqual(canonical.models[0].input, ["text", "image"]);
  assert.equal(canonical.models[0].contextWindow, 272000);
  assert.equal(canonical.models[0].maxTokens, 128000);
  assert.equal(canonical.models[0].api, "openai-responses");
  assert.equal(canonical.models[0].thinkingLevelMap?.off, null);
  assert.deepEqual(canonical.models[0].cost, { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });

  const full = buildProviderModels([cpaModel], astraCatalog, {}, "full");
  assert.equal(full.models[0].contextWindow, 1050000);
});

test("routes every catalog Claude model through the Anthropic Messages API", () => {
  const result = buildProviderModels(CLAUDE_CATALOG_IDS.map((id) => ({ id })), {}, {});

  assert.equal(result.models.length, 16);
  for (const model of result.models) {
    assert.equal(model.api, "anthropic-messages", `${model.id} should use anthropic-messages`);
  }
});

test("leaves non-Claude, non-Codex-Responses models on the provider default API", () => {
  const result = buildProviderModels([
    { id: "gemini-3-pro" },
    { id: "gpt-5.2" },
    { id: "gpt-image-2" },
    { id: "codex-auto-review" },
    { id: "not-claude-opus" },
    { id: "claudette-1" },
  ], {}, {});

  for (const model of result.models) {
    assert.equal(model.api, undefined, `${model.id} should not carry an API override`);
  }
});

test("routes Claude through the Messages API from metadata ids and owner prefixes", () => {
  const result = buildProviderModels(
    [{ id: "claude-opus-4-6-thinking", owned_by: "antigravity" }, { id: "0xdev/claude-opus-5" }],
    catalog,
    { "claude-opus-4-6-thinking": "anthropic/claude-opus-4-6" },
  );

  // First model is enriched (modelFromMetadata), second falls back (defaultModel).
  assert.equal(result.stats.enriched, 1);
  assert.equal(result.models[0].api, "anthropic-messages");
  assert.equal(result.models[1].api, "anthropic-messages");
});

test("recognizes Claude through a canonical metadata alias", () => {
  const result = buildProviderModels(
    [{ id: "custom-opus" }],
    {
      "anthropic/claude-opus-5": {
        id: "anthropic/claude-opus-5",
        name: "Claude Opus 5",
        reasoning: true,
      },
    },
    { "custom-opus": "anthropic/claude-opus-5" },
  );

  assert.equal(result.models[0].api, "anthropic-messages");
});

test("uses provider pricing while keeping the canonical GPT-5.6 context window by default", () => {
  const providerCatalog = {
    "openai/gpt-5.6-sol": {
      id: "openai/gpt-5.6-sol",
      limit: { context: 1050000, output: 128000 },
      cost: {
        input: 5,
        output: 30,
        cache_read: 0.5,
        cache_write: 6.25,
        tiers: [{
          input: 10,
          output: 45,
          cache_read: 1,
          cache_write: 12.5,
          tier: { type: "context", size: 272000 },
        }],
      },
    },
    "routing-run/gpt-5.6-sol": {
      id: "routing-run/gpt-5.6-sol",
      limit: { context: 1000000, output: 128000 },
      cost: { input: 2.5, output: 15 },
    },
  };
  const result = buildProviderModels(
    [{ id: "gpt-5.6-sol", owned_by: "openai" }],
    providerCatalog,
    {},
  );

  assert.deepEqual(result.models[0].cost, {
    input: 5,
    output: 30,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    tiers: [{ inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }],
  });
  assert.equal(result.models[0].contextWindow, 272000);
  assert.equal(result.models[0].maxTokens, 128000);
  assert.equal(result.stats.matchMethods["owner-prefix"], 1);
  assert.equal(result.stats.unmatched, 0);

  const full = buildProviderModels(
    [{ id: "gpt-5.6-sol", owned_by: "openai" }],
    providerCatalog,
    {},
    "full",
  );
  assert.equal(full.models[0].contextWindow, 1050000);
  assert.deepEqual(full.models[0].cost, result.models[0].cost);
});

test("recognizes GPT-5.6 through a canonical metadata alias", () => {
  const result = buildProviderModels(
    [{ id: "custom-luna" }],
    {
      "openai/gpt-5.6-luna": {
        id: "openai/gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        reasoning: true,
      },
    },
    { "custom-luna": "openai/gpt-5.6-luna" },
  );

  assert.equal(result.models[0].reasoning, true);
  assert.equal(result.models[0].api, "openai-responses");
  assert.equal(result.models[0].thinkingLevelMap?.max, "max");
  assert.equal(result.models[0].contextWindow, 272000);
});

test("adds GPT-5.6 capabilities even when metadata is unavailable", () => {
  const result = buildProviderModels([{ id: "0xdev/gpt-5.6-luna" }], {}, {});

  assert.equal(result.models[0].reasoning, true);
  assert.equal(result.models[0].thinkingLevelMap?.off, "none");
  assert.equal(result.models[0].thinkingLevelMap?.max, "max");
  assert.equal(result.models[0].contextWindow, 272000);
});

test("applies bounded user overrides without changing forced model API selection", () => {
  const result = buildProviderModels(
    [{ id: "gpt-5.6-codex" }],
    {},
    {},
    "canonical",
    {
      "gpt-5.6-codex": {
        reasoning: false,
        contextWindow: 512000,
        maxTokens: 32768,
      },
    },
  );

  assert.equal(result.models[0].reasoning, false);
  assert.equal(result.models[0].contextWindow, 512000);
  assert.equal(result.models[0].maxTokens, 32768);
  assert.equal(result.models[0].api, "openai-responses");
  assert.equal(result.models[0].thinkingLevelMap?.max, "max");
});

const effortCatalog = {
  "anthropic/claude-fable-5-1": {
    id: "anthropic/claude-fable-5-1",
    name: "Claude Fable 5.1",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  },
  "anthropic/claude-opus-4-7": {
    id: "anthropic/claude-opus-4-7",
    name: "Claude Opus 4.7",
    reasoning: true,
    reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  },
  "anthropic/claude-opus-4-6": {
    id: "anthropic/claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    reasoning_options: [
      { type: "effort", values: ["low", "medium", "high", "max"] },
      { type: "budget_tokens", min: 1024 },
    ],
  },
  "anthropic/claude-sonnet-4-5": {
    id: "anthropic/claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    reasoning: true,
    reasoning_options: [{ type: "budget_tokens", min: 1024 }],
  },
  "openai/gpt-5.2": {
    id: "openai/gpt-5.2",
    name: "GPT-5.2",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
  },
  "openai/gpt-5.6": {
    id: "openai/gpt-5.6",
    name: "GPT-5.6",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "medium"] }],
  },
  "acme/legacy-thinker": {
    id: "acme/legacy-thinker",
    name: "Legacy",
    reasoning: true,
  },
};

function modelFor(id: string) {
  const result = buildProviderModels([{ id }], effortCatalog, {}, "canonical", {}, null);
  assert.equal(result.stats.enriched, 1, `${id} should match metadata`);
  return result.models[0];
}

test("derives xhigh and max from the models.dev effort list", () => {
  assert.deepEqual(modelFor("claude-fable-5-1").thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });
});

test("leaves off available when models.dev also lists a toggle or budget mode", () => {
  for (const id of ["claude-opus-4-7", "claude-opus-4-6"]) {
    const map = modelFor(id).thinkingLevelMap;
    assert.equal("off" in (map ?? {}), false, `${id} should not pin off`);
    assert.equal(map?.max, "max");
  }
});

test("represents effort holes as null so pi hides only the missing level", () => {
  const map = modelFor("claude-opus-4-6").thinkingLevelMap;
  assert.equal(map?.xhigh, null);
  assert.equal(map?.max, "max");
  assert.equal(map?.high, "high");
});

test("maps a none effort onto pi's off level", () => {
  const map = modelFor("gpt-5.2").thinkingLevelMap;
  assert.equal(map?.off, "none");
  assert.equal(map?.xhigh, "xhigh");
  assert.equal(map?.max, null);
});

test("keeps pi's default budget mapping for budget-only and undescribed reasoning models", () => {
  assert.equal(modelFor("claude-sonnet-4-5").thinkingLevelMap, undefined);
  assert.equal(modelFor("legacy-thinker").thinkingLevelMap, undefined);
});

test("family capability rules win over the models.dev effort list", () => {
  const map = modelFor("gpt-5.6").thinkingLevelMap;
  assert.equal(map?.off, "none");
  assert.equal(map?.xhigh, "xhigh");
  assert.equal(map?.max, "max");
});

const publishedMapCatalog: ModelsDevCatalog = {
  // Shaped like a pi built-in catalog entry: a finished map, no effort list.
  "anthropic/claude-fable-5": {
    id: "anthropic/claude-fable-5",
    name: "Claude Fable 5",
    reasoning: true,
    thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
  },
  // Both: the published map wins over what the effort list would derive.
  "anthropic/claude-opus-4-6": {
    id: "anthropic/claude-opus-4-6",
    name: "Claude Opus 4.6",
    reasoning: true,
    thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", max: "max" },
    reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  },
  // A family rule covers this id, and stays above both.
  "openai/gpt-5.6-luna": {
    id: "openai/gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    reasoning: true,
    thinkingLevelMap: { off: null, max: null },
    reasoning_options: [{ type: "effort", values: ["low"] }],
  },
  // The GPT-6 rule maps `minimal` down to low; a published map claiming
  // otherwise must not override it.
  "openai/gpt-6-astra": {
    id: "openai/gpt-6-astra",
    name: "GPT-6 Astra",
    reasoning: true,
    thinkingLevelMap: { off: "none", minimal: "minimal", low: "low" },
  },
};

test("publishes a thinking map carried by metadata verbatim", () => {
  const result = buildProviderModels([{ id: "claude-fable-5", owned_by: "anthropic" }], publishedMapCatalog, {});

  assert.equal(result.stats.enriched, 1);
  assert.deepEqual(result.models[0].thinkingLevelMap, { off: null, xhigh: "xhigh", max: "max" });
});

test("a published thinking map beats the models.dev effort list", () => {
  const result = buildProviderModels([{ id: "claude-opus-4-6", owned_by: "anthropic" }], publishedMapCatalog, {});

  // The effort list would have produced xhigh: "xhigh" and minimal: null.
  assert.deepEqual(result.models[0].thinkingLevelMap, {
    off: null,
    low: "low",
    medium: "medium",
    high: "high",
    max: "max",
  });
});

test("family capability rules win over a published thinking map", () => {
  const result = buildProviderModels([
    { id: "gpt-5.6-luna", owned_by: "openai" },
    { id: "gpt-6-astra", owned_by: "openai" },
  ], publishedMapCatalog, {});

  assert.deepEqual(result.models[0].thinkingLevelMap, {
    off: "none",
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });
  assert.deepEqual(result.models[1].thinkingLevelMap, {
    off: null,
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });
});

test("keeps the derived thinking map under a user reasoning override, like family maps", () => {
  const result = buildProviderModels(
    [{ id: "claude-fable-5-1" }],
    effortCatalog,
    {},
    "canonical",
    { "claude-fable-5-1": { reasoning: false } },
    null,
  );
  assert.equal(result.models[0].reasoning, false);
  assert.equal(result.models[0].thinkingLevelMap?.xhigh, "xhigh");
});

// --- Pi's native profiles for the upstreams CLIProxyAPI fronts ---

function piModel(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "fixture",
    baseUrl: "https://fixture.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272000,
    maxTokens: 128000,
    ...overrides,
  } as Model<Api>;
}

const piProfiles = loadPiModelProfiles({
  getBuiltinProviders: () => ["anthropic", "openai-codex", "openai"],
  getBuiltinModels: (provider) => ({
    anthropic: [
      piModel("claude-opus-5-5", {
        thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
        compat: { supportsMidConvoEffort: true, supportsMidConvoToolChanges: true } as Model<Api>["compat"],
      }),
      piModel("claude-sonnet-5", { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }),
    ],
    "openai-codex": [
      piModel("gpt-5.5", { api: "openai-codex-responses", thinkingLevelMap: { minimal: "low", xhigh: "xhigh" } }),
      piModel("gpt-5.3-codex-spark", { api: "openai-codex-responses", contextWindow: 128000, thinkingLevelMap: { minimal: "low", xhigh: "xhigh" } }),
      piModel("gpt-5.6-sol", { api: "openai-codex-responses", thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" } }),
      piModel("gpt-6-sol", { api: "openai-codex-responses", thinkingLevelMap: { off: "none", minimal: "low" } }),
    ],
    // The public OpenAI API is not what CPA fronts for these ids.
    openai: [piModel("gpt-4.1", { api: "openai-responses" })],
  } as Record<string, Model<Api>[]>)[provider] ?? [],
  getBuiltinModelDataGeneratedAt: () => 1_700_000_000_000,
});

async function withProfiles(ids: string[], metadata: ModelsDevCatalog = {}) {
  const result = buildProviderModels(ids.map((id) => ({ id })), metadata, {}, "canonical", {}, null, await piProfiles);
  return Object.fromEntries(result.models.map((model) => [model.id, model]));
}

test("publishes per-turn effort only for Claude models pi marks as supporting it", async () => {
  const models = await withProfiles(["claude-opus-5-5", "claude-sonnet-5", "claude-opus-4-6"]);

  assert.deepEqual(models["claude-opus-5-5"].compat, { supportsMidConvoEffort: true });
  // Native tool changes are never carried: CPA's OAuth tool aliasing breaks them.
  assert.equal(models["claude-sonnet-5"].compat, undefined);
  assert.equal(models["claude-opus-4-6"].compat, undefined, "unknown to pi");
});

test("pi's native thinking map wins over family rules and metadata", async () => {
  const models = await withProfiles(["claude-opus-5-5", "gpt-5.6-sol", "plus/gpt-5.6-sol", "gpt-6-sol"], {
    "anthropic/claude-opus-5-5": {
      id: "anthropic/claude-opus-5-5",
      reasoning: true,
      reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high"] }],
    },
  });

  assert.deepEqual(models["claude-opus-5-5"].thinkingLevelMap, { off: null, minimal: null, xhigh: "xhigh", max: "max" });
  assert.deepEqual(models["gpt-5.6-sol"].thinkingLevelMap, { minimal: "low", xhigh: "xhigh", max: "max" });
  assert.deepEqual(models["plus/gpt-5.6-sol"].thinkingLevelMap, models["gpt-5.6-sol"].thinkingLevelMap);
  assert.deepEqual(models["gpt-6-sol"].thinkingLevelMap, { off: "none", minimal: "low" });
});

test("routes any model in pi's Codex catalog through Responses with the canonical window", async () => {
  const models = await withProfiles(["gpt-5.5", "team/gpt-5.5", "gpt-4.1", "codex-auto-review"], {
    "openai/gpt-5.5": { id: "openai/gpt-5.5", reasoning: true, limit: { context: 1050000, output: 128000 } },
  });

  for (const id of ["gpt-5.5", "team/gpt-5.5"]) {
    assert.equal(models[id].api, "openai-responses", id);
    assert.equal(models[id].contextWindow, 272000, id);
    assert.deepEqual(models[id].thinkingLevelMap, { minimal: "low", xhigh: "xhigh" }, id);
  }
  assert.equal(models["gpt-4.1"].api, undefined, "pi's openai/ catalog is not the Codex upstream");
  assert.equal(models["codex-auto-review"].api, undefined);
});

test("keeps family-rule fallbacks for Codex models newer than pi's catalog", async () => {
  const models = await withProfiles(["gpt-5.6-nova", "gpt-6-astra"]);

  assert.equal(models["gpt-5.6-nova"].thinkingLevelMap?.minimal, "low");
  assert.equal(models["gpt-6-astra"].thinkingLevelMap?.off, null);
  assert.equal(models["gpt-6-astra"].api, "openai-responses");
});

test("does not share a profile's thinking map between models", async () => {
  const models = await withProfiles(["gpt-5.6-sol", "plus/gpt-5.6-sol"]);

  models["gpt-5.6-sol"].thinkingLevelMap!.max = null;
  assert.equal(models["plus/gpt-5.6-sol"].thinkingLevelMap?.max, "max");
});

test("an unreadable pi catalog degrades to family rules", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const profiles = await loadPiModelProfiles({
      getBuiltinProviders: () => { throw new Error("no catalog"); },
      getBuiltinModels: () => [],
      getBuiltinModelDataGeneratedAt: () => undefined,
    });
    const result = buildProviderModels([{ id: "claude-opus-5-5" }], {}, {}, "canonical", {}, null, profiles);
    assert.equal(result.models[0].compat, undefined);
    assert.equal(result.models[0].api, "anthropic-messages");
  } finally {
    console.warn = originalWarn;
  }
});

test("per-turn effort can be switched off for CLIProxyAPI releases before v8.0.3", async () => {
  const result = buildProviderModels([{ id: "claude-opus-5-5" }], {}, {}, "canonical", {}, null, await piProfiles, false);

  assert.equal(result.models[0].compat, undefined);
  assert.equal(result.models[0].api, "anthropic-messages", "Claude keeps the Messages API");
  assert.deepEqual(result.models[0].thinkingLevelMap, { off: null, minimal: null, xhigh: "xhigh", max: "max" });
});

test("publishes per-turn effort only when CPA serves the model from an Anthropic owner", async () => {
  const result = buildProviderModels(
    [
      { id: "claude-opus-5-5", owned_by: "anthropic" },
      { id: "ag/claude-opus-5-5", owned_by: "antigravity" },
    ],
    {}, {}, "canonical", {}, null, await piProfiles,
  );
  const [anthropic, antigravity] = result.models;

  assert.deepEqual(anthropic.compat, { supportsMidConvoEffort: true });
  assert.equal(antigravity.compat, undefined, "translated away from the Messages shape");
});

test("uses pi's native context window for Codex models smaller than the family default", async () => {
  const metadata: ModelsDevCatalog = {
    "openai/gpt-5.3-codex-spark": { id: "openai/gpt-5.3-codex-spark", reasoning: true, limit: { context: 400000, output: 128000 } },
  };
  const canonical = await withProfiles(["gpt-5.3-codex-spark", "pro/gpt-5.3-codex-spark"], metadata);
  for (const id of ["gpt-5.3-codex-spark", "pro/gpt-5.3-codex-spark"]) {
    assert.equal(canonical[id].api, "openai-responses", id);
    assert.equal(canonical[id].contextWindow, 128000, id);
  }

  const profiles = await piProfiles;
  const full = buildProviderModels([{ id: "gpt-5.3-codex-spark" }], metadata, {}, "full", {}, null, profiles);
  assert.equal(full.models[0].contextWindow, 400000, "full opts into the models.dev limit");
  const fullUnmatched = buildProviderModels([{ id: "gpt-5.3-codex-spark" }], {}, {}, "full", {}, null, profiles);
  assert.equal(fullUnmatched.models[0].contextWindow, 128000, "never widened past pi without metadata");
});

test("keeps GPT-5.5 on Responses once a pi upgrade drops it from the Codex catalog", () => {
  const result = buildProviderModels([{ id: "gpt-5.5" }, { id: "gpt-5.50" }], {
    "openai/gpt-5.5": { id: "openai/gpt-5.5", reasoning: true, limit: { context: 1050000, output: 128000 } },
  }, {}, "canonical", {}, null, NO_PI_PROFILES);
  const [gpt55, lookalike] = result.models;

  assert.equal(gpt55.api, "openai-responses");
  assert.equal(gpt55.contextWindow, 272000);
  assert.deepEqual(gpt55.thinkingLevelMap, { minimal: "low", xhigh: "xhigh" }, "mirrors pi's native map");
  assert.equal(lookalike.api, undefined);
});
