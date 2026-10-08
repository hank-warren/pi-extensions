import test from "node:test";
import assert from "node:assert/strict";
import { findMetadataMatch, findRouteMetadataMatch } from "../src/matching.ts";
import { buildProviderModels, PI_MODEL_DEFAULTS } from "../src/provider.ts";
import type { CpaModel } from "../src/cpa.ts";
import type { ModelsDevCatalog } from "../src/types.ts";

const catalog: ModelsDevCatalog = {
  "openai/gpt-6-sol": {
    id: "gpt-6-sol",
    sourceProvider: "openai",
    name: "GPT-6 Sol",
    reasoning: true,
    modalities: { input: ["text", "image"] },
    limit: { context: 1050000, output: 128000 },
    cost: { input: 2, output: 10 },
  },
  "openai/gpt-5.6-sol": { id: "gpt-5.6-sol", sourceProvider: "openai", name: "GPT-5.6 Sol", limit: { context: 1050000, output: 128000 } },
  "openrouter/openai/gpt-5.6-sol": { id: "openai/gpt-5.6-sol", sourceProvider: "openrouter", name: "GPT-5.6 Sol (OpenRouter)" },
  "anthropic/claude-opus-5-5": {
    id: "claude-opus-5-5",
    sourceProvider: "anthropic",
    name: "Claude Opus 5.5",
    reasoning: true,
    modalities: { input: ["text", "image"] },
    limit: { context: 1000000, output: 128000 },
    cost: { input: 4, output: 20 },
  },
  "moonshotai/kimi-k3": { id: "kimi-k3", sourceProvider: "moonshotai", name: "Kimi K3", limit: { context: 1048576, output: 32768 } },
  "openai/gpt-image-2": { id: "gpt-image-2", sourceProvider: "openai", name: "GPT Image 2", limit: { context: 0, output: 0 }, cost: { input: 5, output: 30 } },
};

test("an account-pinned prefix reuses the base model's metadata", () => {
  for (const id of ["team/gpt-6-sol", "plus/gpt-6-sol"]) {
    const match = findRouteMetadataMatch({ id, owned_by: "openai" }, catalog, {});
    assert.equal(match?.metadataId, "openai/gpt-6-sol", id);
    assert.equal(match?.method, "route-base", id);
  }
  assert.equal(findMetadataMatch({ id: "team/gpt-6-sol", owned_by: "openai" }, catalog, {}), undefined);
});

test("an alias or catalog entry written for the prefixed id still wins over the base model", () => {
  const aliased = findRouteMetadataMatch(
    { id: "devin/claude-opus-5-5", owned_by: "anthropic" },
    catalog,
    { "devin/claude-opus-5-5": "openai/gpt-6-sol" },
  );
  assert.equal(aliased?.method, "alias");

  const baseAlias = findRouteMetadataMatch({ id: "devin/mystery", owned_by: "cognition" }, catalog, { mystery: "anthropic/claude-opus-5-5" });
  assert.equal(baseAlias?.metadataId, "anthropic/claude-opus-5-5");
  assert.equal(baseAlias?.method, "route-base");
});

test("a canonical owner resolves Devin's dashed version spelling within that owner", () => {
  const match = findRouteMetadataMatch({ id: "devin/gpt-5-6-sol", owned_by: "openai" }, catalog, {}, "openrouter");
  assert.equal(match?.metadataId, "openai/gpt-5.6-sol");
});

test("CPA's moonshot owner resolves to models.dev's moonshotai provider", () => {
  const match = findRouteMetadataMatch({ id: "devin/kimi-k3", owned_by: "moonshot" }, catalog, {});
  assert.equal(match?.metadataId, "moonshotai/kimi-k3");
});

test("a bare id is never retried as a route base", () => {
  assert.equal(findRouteMetadataMatch({ id: "nothing-here", owned_by: "openai" }, catalog, {}), undefined);
});

test("a prefixed GPT model gets the base model's cost and CPA's output limit, and keeps its own id and wire", () => {
  const [model] = buildProviderModels(
    [{ id: "team/gpt-6-sol", owned_by: "openai", spec: { contextWindow: 272000, maxContextWindow: 872000, maxTokens: 128000 } }],
    catalog,
    {},
  ).models;

  assert.equal(model.id, "team/gpt-6-sol");
  assert.equal(model.api, "openai-responses");
  assert.equal(model.contextWindow, 272000);
  assert.equal(model.maxTokens, 128000);
  assert.deepEqual(model.cost, { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 });
});

test("CPA's limits win over models.dev for a route narrower than the model", () => {
  const result = buildProviderModels(
    [{ id: "devin/claude-opus-5-5", owned_by: "anthropic", spec: { contextWindow: 1000000, maxTokens: 64000, displayName: "Claude Opus 5.5 (Devin)" } }],
    catalog,
    {},
  );
  const [model] = result.models;

  assert.equal(model.api, "anthropic-messages");
  assert.equal(model.maxTokens, 64000);
  assert.equal(model.contextWindow, 1000000);
  assert.equal(model.name, "Claude Opus 5.5 (Devin)");
  assert.equal(model.cost.input, 4);
  assert.equal(result.stats.matchMethods["route-base"], 1);
  assert.equal(result.stats.cpaSpecs, 1);
});

test("the canonical Codex window is the smaller of CPA's and the default, and full mode uses CPA's ceiling", () => {
  const cpaModel: CpaModel = { id: "gpt-6-sol", owned_by: "openai", spec: { contextWindow: 200000, maxContextWindow: 872000, maxTokens: 128000 } };

  assert.equal(buildProviderModels([cpaModel], catalog, {}, "canonical").models[0].contextWindow, 200000);
  assert.equal(buildProviderModels([cpaModel], catalog, {}, "full").models[0].contextWindow, 872000);
  const noSpec = { id: "gpt-6-sol", owned_by: "openai" };
  assert.equal(buildProviderModels([noSpec], catalog, {}, "full").models[0].contextWindow, 1050000);
});

test("CPA's effort list describes a model nothing else knows", () => {
  const [model] = buildProviderModels(
    [{ id: "devin/swe-2", owned_by: "cognition", spec: { contextWindow: 262000, maxTokens: 64000, reasoningLevels: ["medium", "high", "max"] } }],
    catalog,
    {},
  ).models;

  assert.equal(model.reasoning, true);
  assert.deepEqual(model.thinkingLevelMap, { minimal: null, low: null, medium: "medium", high: "high", xhigh: null, max: "max" });
  assert.equal(model.contextWindow, 262000);
  assert.equal(model.maxTokens, 64000);
});

test("CPA's template filler effort list is ignored, so a non-reasoning model stays non-reasoning", () => {
  const [model] = buildProviderModels(
    [{ id: "claude-3-5-haiku-20241022", owned_by: "anthropic", spec: { maxTokens: 8192, reasoningLevels: ["low", "medium", "high", "xhigh"] } }],
    {},
    {},
  ).models;

  assert.equal(model.reasoning, false);
  assert.equal(model.thinkingLevelMap, undefined);
  assert.equal(model.maxTokens, 8192);
});

test("a models.dev limit of 0 counts as unknown rather than a 0-token window", () => {
  for (const id of ["gpt-image-2", "plus/gpt-image-2"]) {
    const [model] = buildProviderModels([{ id, owned_by: "openai" }], catalog, {}).models;
    assert.equal(model.contextWindow, PI_MODEL_DEFAULTS.contextWindow, id);
    assert.equal(model.maxTokens, PI_MODEL_DEFAULTS.maxTokens, id);
  }
});
