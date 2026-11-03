import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { conflictingEnvironment, claudeEnvironment, discoverClaudeModels, clearReadyStatusCache } from "../src/claude-cli.ts";
import { registerCreatedSession, sweepCreatedSessions } from "../src/cleanup.ts";
import { FALLBACK_MODELS, modelFromDiscovery, PROVIDER_ID, API_ID } from "../src/model-catalog.ts";
import { effortFor, mcpInputSchema } from "../src/stream.ts";
import {
  chainEntries,
  nativeToolUseId,
  normalizeMessages,
  prefixHashes,
  nextPrefixHash,
  stdinContent,
  synthesizeEntries,
  TOOL_PREFIX,
} from "../src/transcript.ts";
import { foreignAssistant, toolResult, useFakeClaude, user } from "./support/fake.ts";

const ours = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage =>
  ({ ...foreignAssistant(""), content, provider: PROVIDER_ID, api: API_ID, model: "claude-haiku-5-5", stopReason }) as AssistantMessage;

test("normalizeMessages drops failed turns, answers orphaned calls and ignores system messages", () => {
  const call = { type: "toolCall" as const, id: "toolu_1", name: "lookup", arguments: { word: "a" } };
  const messages = [
    { role: "system", content: "sys", timestamp: 0 },
    user("hi"),
    ours([{ type: "text", text: "partial" }], "aborted"),
    ours([call], "toolUse"),
    user("interrupting"),
    toolResult({ id: "stray", name: "lookup" }, "ignored"),
  ] as Message[];
  const normalized = normalizeMessages(messages);
  assert.deepEqual(
    normalized.map((message) => message.role),
    ["user", "assistant", "toolResult", "user"],
  );
  const synthetic = normalized[2] as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(synthetic.content[0]!.text, "No result provided");
  assert.equal(synthetic.isError, true);
});

test("prefix hashes depend on content only and chain", () => {
  const a = [user("one"), ours([{ type: "text", text: "two" }])];
  const b = [{ ...user("one"), timestamp: 42 }, { ...ours([{ type: "text", text: "two" }]), usage: { ...ours([]).usage, input: 9 } }];
  assert.deepEqual(prefixHashes(normalizeMessages(a)), prefixHashes(normalizeMessages(b)));
  const hashes = prefixHashes(normalizeMessages(a));
  assert.equal(nextPrefixHash(hashes[0], normalizeMessages(a)[1]!), hashes[1]);
  assert.notEqual(prefixHashes(normalizeMessages([user("one!")]))[0], hashes[0]);
});

test("stdin frames put tool results first and map foreign tool ids", () => {
  const frame = stdinContent([
    toolResult({ id: "call|abc", name: "lookup" }, "out"),
    { role: "user", content: [{ type: "text", text: "next" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 0 },
  ] as never);
  assert.deepEqual(frame, [
    { type: "tool_result", tool_use_id: "call_abc", content: [{ type: "text", text: "out" }] },
    { type: "text", text: "next" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
  ]);
  assert.equal(nativeToolUseId("toolu_01ABC"), "toolu_01ABC");
  assert.match(nativeToolUseId("x".repeat(80)), /^[A-Za-z0-9_-]{1,64}$/u);
});

test("synthesized entries keep this provider's thinking and drop foreign thinking", () => {
  const messages = normalizeMessages([
    user("q"),
    ours([
      { type: "thinking", thinking: "mine", thinkingSignature: "sig" },
      { type: "text", text: "a1" },
    ]),
    user("q2"),
    { ...foreignAssistant("a2"), content: [{ type: "thinking", thinking: "theirs", thinkingSignature: "x" }, { type: "text", text: "a2" }] } as AssistantMessage,
  ]);
  const { lines, uuids, leafUuid } = synthesizeEntries(messages, 0, null, { sessionId: "s", cwd: "/w", version: "2.1.316", model: "m" });
  assert.equal(lines.length, 4);
  assert.equal(lines[0]!.parentUuid, null);
  assert.equal(lines[1]!.parentUuid, lines[0]!.uuid);
  assert.equal(leafUuid, lines[3]!.uuid);
  assert.equal(uuids.get(3), lines[3]!.uuid);
  const first = (lines[1]!.message as { content: Array<{ type: string }> }).content;
  const second = (lines[3]!.message as { content: Array<{ type: string }> }).content;
  assert.deepEqual(first.map((block) => block.type), ["thinking", "text"]);
  assert.deepEqual(second.map((block) => block.type), ["text"]);
  for (const line of lines) {
    assert.equal(line.entrypoint, "sdk-cli");
    assert.equal(line.userType, "external");
    assert.equal(line.isSidechain, false);
    assert.equal(line.sessionId, "s");
  }
});

test("synthesized tool results reference the assistant that called them", () => {
  const messages = normalizeMessages([
    user("q"),
    ours([{ type: "toolCall", id: "toolu_9", name: "lookup", arguments: { word: "w" } }], "toolUse"),
    toolResult({ id: "toolu_9", name: "lookup" }, "r"),
  ]);
  const { lines } = synthesizeEntries(messages, 0, "parent-uuid", { sessionId: "s", cwd: "/w", version: "v", model: "m" });
  assert.equal(lines[0]!.parentUuid, "parent-uuid");
  const result = lines[2]!;
  assert.equal(result.sourceToolAssistantUUID, lines[1]!.uuid);
  assert.deepEqual(result.message, {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_9", content: [{ type: "text", text: "r" }] }],
  });
  assert.deepEqual((lines[1]!.message as { content: unknown[] }).content, [
    { type: "tool_use", id: "toolu_9", name: `${TOOL_PREFIX}lookup`, input: { word: "w" } },
  ]);
});

test("chainEntries walks parents from a leaf and ignores other branches", () => {
  const text = [
    { uuid: "a", parentUuid: null, type: "user" },
    { type: "queue-operation" },
    { uuid: "b", parentUuid: "a", type: "assistant" },
    { uuid: "c", parentUuid: "b", type: "user" },
    { uuid: "x", parentUuid: "a", type: "assistant" },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  assert.deepEqual(chainEntries(text, "c")?.map((entry) => entry.uuid), ["a", "b", "c"]);
  assert.equal(chainEntries(text, "missing"), undefined);
});

test("model rows map effort levels and Claude Code's context window", () => {
  const model = modelFromDiscovery({
    value: "claude-opus-4-6",
    resolvedModel: "claude-opus-4-6",
    displayName: "Opus 4.6",
    description: "",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
    supportsAdaptiveThinking: true,
    supportsThinkingOff: true,
    contextWindow: 200_000,
  });
  assert.equal(model.contextWindow, 200_000);
  assert.equal(model.maxTokens, 128_000);
  assert.equal(model.provider, "claude-sub");
  assert.doesNotMatch(model.name, /Claude Code/u);
  assert.deepEqual(model.thinkingLevelMap, { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: "max" });
  assert.deepEqual(effortFor(model, "max"), { effort: "max", thinkingOff: false });
  assert.deepEqual(effortFor(model, undefined), { thinkingOff: true });
  const haiku = FALLBACK_MODELS.find((entry) => entry.id === "claude-haiku-5-5")!;
  assert.equal(haiku.contextWindow, 1_000_000);
  assert.equal(haiku.thinkingLevelMap?.off, null);
  assert.equal(haiku.promptCache, undefined);
  for (const entry of FALLBACK_MODELS) assert.doesNotMatch(entry.name, /Claude Code/u);
});

test("tool schemas stay intact below the top level", () => {
  const nested = { type: "object", properties: { a: { oneOf: [{ type: "string" }, { type: "number" }] } } };
  assert.deepEqual(mcpInputSchema(nested), nested);
  assert.deepEqual(mcpInputSchema({ anyOf: [{ type: "object" }] }), { type: "object", properties: {} });
});

test("environment refuses auth and backend overrides and enables threads", () => {
  assert.deepEqual(conflictingEnvironment({ ANTHROPIC_BASE_URL: "http://x", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_BEDROCK: "0" }), [
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_VERTEX",
  ]);
  assert.throws(() => claudeEnvironment({ ANTHROPIC_AUTH_TOKEN: "t" }), /ANTHROPIC_AUTH_TOKEN/u);
  const env = claudeEnvironment({ CLAUDE_CODE_EXTRA_BODY: "{}" });
  assert.equal(env.CLAUDE_CODE_TETHER_LIVE, "1");
  assert.equal(env.DISABLE_AUTO_COMPACT, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS, "1");
  assert.equal(env.CLAUDE_CODE_EXTRA_BODY, undefined);
  assert.equal(claudeEnvironment({ PI_CLAUDE_SUB_THREADS: "0" }).CLAUDE_CODE_TETHER_LIVE, undefined);
});

test("model discovery reads Claude Code's catalog and context windows without a model request", async () => {
  const { log } = useFakeClaude();
  const models = await discoverClaudeModels(process.env);
  assert.deepEqual(
    models.map((model) => [model.resolvedModel, model.contextWindow]),
    [
      ["claude-fake-1", 1_000_000],
      ["claude-fake-small", 200_000],
    ],
  );
  assert.equal(existsSync(log) ? (await import("node:fs")).readFileSync(log, "utf8").includes('"request"') : false, false);
});

test("subscription login is required", async () => {
  useFakeClaude();
  process.env.FAKE_CLAUDE_PLAN = "";
  clearReadyStatusCache();
  try {
    await assert.rejects(discoverClaudeModels(process.env), /subscription/u);
  } finally {
    delete process.env.FAKE_CLAUDE_PLAN;
    clearReadyStatusCache();
  }
});

test("only registered Claude Code sessions past retention are swept", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "projects-"));
  const old = "11111111-1111-4111-8111-111111111111";
  const fresh = "22222222-2222-4222-8222-222222222222";
  const foreign = "33333333-3333-4333-8333-333333333333";
  for (const id of [old, fresh, foreign]) writeFileSync(join(projectDir, `${id}.jsonl`), "{}\n");
  mkdirSync(join(projectDir, old));
  await registerCreatedSession(projectDir, old);
  await registerCreatedSession(projectDir, fresh);
  const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000);
  utimesSync(join(projectDir, `${old}.jsonl`), past, past);
  const removed = await sweepCreatedSessions(Date.now() + 1_000, 7 * 24 * 60 * 60 * 1_000 + 2_000);
  assert.equal(removed, 0, "registration time also counts");
  const later = await sweepCreatedSessions(Date.now() + 8 * 24 * 60 * 60 * 1_000, 7 * 24 * 60 * 60 * 1_000);
  assert.equal(later, 2);
  assert.equal(existsSync(join(projectDir, `${old}.jsonl`)), false);
  assert.equal(existsSync(join(projectDir, old)), false);
  assert.equal(existsSync(join(projectDir, `${foreign}.jsonl`)), true);
});
