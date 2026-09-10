import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProviderCatalog } from "../src/catalog.ts";
import { cpaModelsCachePath, modelsDevCachePath } from "../src/discovery.ts";
import { writeCache } from "../src/cache.ts";
import type { CpaProviderConfig } from "../src/types.ts";

const config: CpaProviderConfig = {
  providerName: "cpa-catalog-test",
  baseUrl: "http://cliproxyapi.test/v1",
  authRequired: false,
  authHeader: false,
  headers: {},
  modelsDevEnabled: true,
  metadataFallbackProvider: "openrouter",
  modelAliases: {},
  modelOverrides: {},
};

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "pi-cpa-catalog-"));
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function catalog(): ProviderCatalog {
  return new ProviderCatalog({
    config,
    gpt56ContextWindow: "canonical",
    getApiKey: async () => undefined,
    backgroundTimeoutMs: 50,
  });
}

test("catalog load ignores malformed source snapshots", async () => {
  await withTempHome(async () => {
    const path = cpaModelsCachePath(config);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ fetchedAt: Date.now(), data: { id: "not-an-array" } }));

    const snapshot = await catalog().load();

    assert.deepEqual(snapshot.cpaModels, []);
    assert.equal(snapshot.built.stats.total, 0);
  });
});

test("catalog load is cache-first and performs no network request", async () => {
  await withTempHome(async () => {
    await writeCache(cpaModelsCachePath(config), [{ id: "cached", owned_by: "openai" }], 1234);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network should not run"); }) as typeof fetch;
    try {
      const snapshot = await catalog().load();
      assert.deepEqual(snapshot.cpaModels.map((model) => model.id), ["cached"]);
      assert.equal(snapshot.cpaUpdatedAt, 1234);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("seeds provider-qualified metadata from pi's built-in catalog on a first run", async () => {
  await withTempHome(async () => {
    await writeCache(cpaModelsCachePath(config), [{ id: "claude-fable-5", owned_by: "anthropic" }]);

    const snapshot = await catalog().load();

    assert.equal(snapshot.metadataSource, "builtin");
    const seeded = snapshot.metadata["anthropic/claude-fable-5"];
    assert.equal(seeded.sourceProvider, "anthropic");
    assert.equal(seeded.cost?.input, 10);
    assert.equal(seeded.thinkingLevelMap?.xhigh, "xhigh");
    assert.equal(snapshot.built.models[0].name, "Claude Fable 5");
    assert.equal(snapshot.built.models[0].thinkingLevelMap?.xhigh, "xhigh");
    assert.equal(snapshot.built.stats.matchMethods["owner-prefix"], 1);
  });
});

test("ignores legacy flat metadata caches and falls back to the built-in seed", async () => {
  await withTempHome(async () => {
    await writeCache(modelsDevCachePath(), {
      "anthropic/claude-fable-5": { id: "anthropic/claude-fable-5", name: "Legacy Fable", reasoning: true },
    }, 1234);
    await writeCache(cpaModelsCachePath(config), [{ id: "claude-fable-5", owned_by: "anthropic" }]);

    const snapshot = await catalog().load();

    assert.equal(snapshot.metadataSource, "builtin");
    assert.notEqual(snapshot.metadataUpdatedAt, 1234);
    assert.equal(snapshot.built.models[0].name, "Claude Fable 5");
  });
});

test("metadata comparison ignores object key order", async () => {
  await withTempHome(async () => {
    await writeCache(modelsDevCachePath(), {
      "openai/fresh": { id: "openai/fresh", sourceProvider: "openai", reasoning: true, name: "Fresh" },
    }, 1234);
    const instance = catalog();
    assert.equal((await instance.load()).metadataSource, "cache");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      assert.equal(String(url), "https://models.dev/api.json");
      return new Response(JSON.stringify({
        openai: { models: { fresh: { reasoning: true, name: "Fresh", id: "fresh" } } },
      }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await instance.refresh("metadata", "manual");
      assert.equal(result.metadata.updated, true);
      assert.equal(result.metadata.changed, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("background refresh updates CPA models while retaining metadata", async () => {
  await withTempHome(async () => {
    await writeCache(cpaModelsCachePath(config), [{ id: "cached", owned_by: "openai" }]);
    const instance = catalog();
    await instance.load();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      assert.equal(String(url), "http://cliproxyapi.test/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-luna", owned_by: "openai" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await instance.refresh("models", "background");
      assert.equal(result.models.updated, true);
      assert.equal(result.models.changed, true);
      assert.deepEqual(result.snapshot.cpaModels.map((model) => model.id), ["gpt-5.6-luna"]);
      // Metadata is still the built-in seed, which is what marks this model reasoning.
      assert.equal(result.snapshot.built.models[0].reasoning, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("snapshot write failure preserves the in-memory CPA snapshot", async () => {
  await withTempHome(async () => {
    await writeCache(cpaModelsCachePath(config), [{ id: "cached", owned_by: "openai" }]);
    const instance = new ProviderCatalog({
      config,
      gpt56ContextWindow: "canonical",
      getApiKey: async () => undefined,
      writeSnapshot: async () => { throw new Error("disk full"); },
    });
    await instance.load();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: "fresh" }] }), { status: 200 })) as typeof fetch;
    try {
      const result = await instance.refresh("models", "manual");
      assert.match(String(result.models.error), /disk full/);
      assert.equal(result.models.updated, false);
      assert.deepEqual(result.snapshot.cpaModels.map((model) => model.id), ["cached"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("failed background refresh preserves the last-known-good CPA snapshot", async () => {
  await withTempHome(async () => {
    await writeCache(cpaModelsCachePath(config), [{ id: "cached", owned_by: "openai" }]);
    const instance = catalog();
    await instance.load();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    try {
      const result = await instance.refresh("models", "background");
      assert.match(String(result.models.error), /offline/);
      assert.deepEqual(result.snapshot.cpaModels.map((model) => model.id), ["cached"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("refresh deduplicates concurrent requests", async () => {
  await withTempHome(async () => {
    const instance = catalog();
    await instance.load();
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ data: [{ id: "fresh" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const keyFn = async () => "runtime-key";
      await Promise.all([
        instance.refresh("models", "background", keyFn, new AbortController().signal),
        instance.refresh("models", "background", keyFn, new AbortController().signal),
      ]);
      assert.equal(fetches, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("deduplicated callers can abort without cancelling the shared refresh", async () => {
  await withTempHome(async () => {
    const instance = catalog();
    await instance.load();
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ data: [{ id: "fresh" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const firstController = new AbortController();
      const secondController = new AbortController();
      const reason = new Error("second caller cancelled");
      const keyFn = async () => "runtime-key";
      const first = instance.refresh("models", "background", keyFn, firstController.signal);
      const second = instance.refresh("models", "background", keyFn, secondController.signal);
      secondController.abort(reason);

      await assert.rejects(second, (error) => error === reason);
      const result = await first;
      assert.equal(result.models.updated, true);
      assert.equal(fetches, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("refresh propagates the initiating caller's cancellation reason", async () => {
  await withTempHome(async () => {
    const instance = catalog();
    await instance.load();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      throw new Error("unreachable");
    }) as typeof fetch;
    try {
      const controller = new AbortController();
      const reason = new Error("caller cancelled");
      const refresh = instance.refresh("models", "manual", async () => undefined, controller.signal);
      controller.abort(reason);

      await assert.rejects(refresh, (error) => error === reason);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function catalogWithClock(now: () => number, staleAfterMs = 1_000): ProviderCatalog {
  return new ProviderCatalog({
    config,
    gpt56ContextWindow: "canonical",
    getApiKey: async () => undefined,
    backgroundTimeoutMs: 50,
    metadataStaleAfterMs: staleAfterMs,
    now,
  });
}

const modelsDevPayload = {
  openai: {
    models: {
      "gpt-5.6-luna": { id: "gpt-5.6-luna", name: "Fresh from models.dev", reasoning: true, limit: { context: 400000, output: 64000 } },
    },
  },
};

test("metadata is stale when only the built-in seed is loaded", async () => {
  await withTempHome(async () => {
    const instance = catalog();
    const snapshot = await instance.load();
    assert.equal(snapshot.metadataSource, "builtin");
    assert.equal(instance.metadataIsStale(snapshot), true);
  });
});

test("metadata is fresh inside the threshold and stale past it", async () => {
  await withTempHome(async () => {
    let now = 100_000;
    await writeCache(modelsDevCachePath(), { "openai/fresh": { id: "openai/fresh", sourceProvider: "openai" } }, now);
    const instance = catalogWithClock(() => now, 1_000);
    const snapshot = await instance.load();
    assert.equal(snapshot.metadataSource, "cache");

    now = 100_999;
    assert.equal(instance.metadataIsStale(snapshot), false);
    now = 101_000;
    assert.equal(instance.metadataIsStale(snapshot), true);
  });
});

test("metadata is never stale when models.dev is disabled", async () => {
  await withTempHome(async () => {
    const instance = new ProviderCatalog({
      config: { ...config, modelsDevEnabled: false },
      gpt56ContextWindow: "canonical",
      getApiKey: async () => undefined,
    });
    const snapshot = await instance.load();
    assert.equal(snapshot.metadataSource, "disabled");
    assert.equal(instance.metadataIsStale(snapshot), false);
  });
});

test("models-if-stale skips models.dev when the metadata snapshot is fresh", async () => {
  await withTempHome(async () => {
    const now = 100_000;
    await writeCache(cpaModelsCachePath(config), [{ id: "cached", owned_by: "openai" }]);
    await writeCache(modelsDevCachePath(), { "openai/fresh": { id: "openai/fresh", sourceProvider: "openai" } }, now);
    const instance = catalogWithClock(() => now);
    await instance.load();
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: "fresh", owned_by: "openai" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await instance.refresh("models-if-stale", "background");
      assert.equal(result.models.updated, true);
      assert.equal(result.metadata.attempted, false);
      assert.deepEqual(urls, ["http://cliproxyapi.test/v1/models"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("models-if-stale fetches models.dev when the snapshot is the built-in seed or stale", async () => {
  await withTempHome(async () => {
    await writeCache(cpaModelsCachePath(config), [{ id: "gpt-5.6-luna", owned_by: "openai" }]);
    const instance = catalog();
    const before = await instance.load();
    assert.equal(before.metadataSource, "builtin");
    assert.equal(before.built.models[0].name, "GPT-5.6 Luna");
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).includes("models.dev")) return new Response(JSON.stringify(modelsDevPayload), { status: 200 });
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-luna", owned_by: "openai" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await instance.refresh("models-if-stale", "background");
      assert.equal(result.metadata.attempted, true);
      assert.equal(result.metadata.updated, true);
      assert.equal(result.snapshot.metadataSource, "cache");
      assert.equal(result.snapshot.built.models[0].name, "Fresh from models.dev");
      assert.equal(result.snapshot.built.models[0].maxTokens, 64000);
      assert.deepEqual(urls.sort(), ["http://cliproxyapi.test/v1/models", "https://models.dev/api.json"]);
      // The refreshed snapshot is no longer stale, so the next routine refresh skips it.
      assert.equal(instance.metadataIsStale(result.snapshot), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a failed stale-metadata fetch keeps the previous metadata and still publishes CPA models", async () => {
  await withTempHome(async () => {
    await writeCache(cpaModelsCachePath(config), [{ id: "cached", owned_by: "openai" }]);
    const instance = catalog();
    await instance.load();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("models.dev")) return new Response("upstream down", { status: 503 });
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-luna", owned_by: "openai" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await instance.refresh("models-if-stale", "background");
      assert.equal(result.models.updated, true);
      assert.deepEqual(result.snapshot.cpaModels.map((model) => model.id), ["gpt-5.6-luna"]);
      assert.equal(result.metadata.attempted, true);
      assert.equal(result.metadata.updated, false);
      assert.ok(result.metadata.error);
      assert.equal(result.snapshot.metadataSource, "builtin");
      assert.equal(result.snapshot.built.models[0].name, "GPT-5.6 Luna");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
