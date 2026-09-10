import test from "node:test";
import assert from "node:assert/strict";
import { formatStatusFailure, metadataStatusLine } from "../src/commands.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

test("status failure includes configuration and next steps", () => {
  const message = formatStatusFailure(DEFAULT_CONFIG, new TypeError("fetch failed"));

  assert.match(message, /CLIProxyAPI status failed: fetch failed/);
  assert.match(message, /Provider: cpa/);
  assert.match(message, /Base URL: http:\/\/localhost:8317\/v1/);
  assert.match(message, /Run \/cliproxyapi config/);
});

test("status names the built-in seed and dates it by pi's catalog generation", () => {
  const line = metadataStatusLine(
    { metadataSource: "builtin", metadataUpdatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 },
    true,
  );

  assert.equal(line, "models.dev metadata: builtin (pi catalog generated 2d ago) (stale; refreshes on next model discovery)");
});

test("status dates a cached snapshot by its fetch", () => {
  const line = metadataStatusLine({ metadataSource: "cache", metadataUpdatedAt: Date.now() - 90_000 });

  assert.equal(line, "models.dev metadata: cache, 2m ago");
});

test("status omits the age when metadata is disabled", () => {
  assert.equal(metadataStatusLine({ metadataSource: "disabled" }), "models.dev metadata: disabled");
});
