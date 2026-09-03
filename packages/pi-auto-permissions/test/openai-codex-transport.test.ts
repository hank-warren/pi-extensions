import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { isOpenAICodexModel } from "../openai-codex-transport.ts";

describe("OpenAI Codex transport selection", () => {
  test("recognizes Codex transport by API so provider aliases retain websocket sessions", () => {
    const luna = openaiCodexProvider()
      .getModels()
      .find((model) => model.id === "gpt-5.6-luna");

    assert.ok(luna);
    assert.equal(isOpenAICodexModel(luna), true);
    assert.equal(isOpenAICodexModel({ api: "openai-responses" }), false);
  });
});
