import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { manager } from "../src/stream.ts";
import { foreignAssistant, readLog, runTurn, text, toolResult, useFakeClaude, user } from "./support/fake.ts";

let log = "";

beforeEach(async () => {
  await manager.closeAll();
  ({ log } = useFakeClaude());
});

after(async () => {
  await manager.closeAll();
});

const requests = () => readLog(log).filter((entry) => entry.event === "request");
const starts = () => readLog(log).filter((entry) => entry.event === "start");
const callsOf = (message: AssistantMessage) => message.content.filter((block): block is ToolCall => block.type === "toolCall");

test("a linear conversation reuses one Claude Code process and continues its thread", async () => {
  const messages: Message[] = [user("hello")];
  const first = await runTurn(messages);
  assert.equal(first.message.stopReason, "stop", first.message.errorMessage);
  assert.equal(first.path, "fresh");
  assert.equal(text(first.message), "echo: hello");
  messages.push(first.message, user("again"));
  const second = await runTurn(messages);
  assert.equal(second.path, "continue");
  assert.equal(text(second.message), "echo: again");
  const seen = requests();
  assert.deepEqual(seen.map((entry) => entry.thread), ["create", "continue"]);
  assert.equal(new Set(seen.map((entry) => entry.pid)).size, 1);
  assert.equal(starts().length, 1);
  // Usage is the full conversation as Claude Code reports it, not the thread delta.
  assert.equal(second.message.usage.cacheRead, 300);
  assert.equal(second.message.usage.input, 3);
  assert.equal(second.message.usage.cacheWrite, 10);
  assert.equal(second.message.usage.output, 7);
  assert.equal(second.message.usage.reasoning, 2);
  assert.equal(second.message.usage.totalTokens, 3 + 300 + 10 + 7);
  assert.ok(second.message.diagnostics?.some((item) => item.type === "claude-sub.anchor"));
});

test("tool calls park in Claude Code and Pi's real results answer them", async () => {
  const messages: Message[] = [user('CALL lookup {"word":"alpha"}\nCALL lookup {"word":"beta"}')];
  const first = await runTurn(messages);
  assert.equal(first.message.stopReason, "toolUse", first.message.errorMessage);
  const calls = callsOf(first.message);
  assert.deepEqual(calls.map((call) => [call.name, call.arguments]), [
    ["lookup", { word: "alpha" }],
    ["lookup", { word: "beta" }],
  ]);
  messages.push(first.message, toolResult(calls[0]!, "A=35"), toolResult(calls[1]!, "B=28", true));
  const second = await runTurn(messages);
  assert.equal(second.path, "tool-results");
  assert.equal(text(second.message), "tool results: [result A=35] [result B=28]");
  assert.equal(starts().length, 1);
  assert.deepEqual(requests().map((entry) => entry.thread), ["create", "continue"]);
  const listed = readLog(log).find((entry) => entry.event === "tools")?.tools;
  assert.deepEqual(listed?.[0]?.inputSchema, {
    type: "object",
    properties: { word: { type: "string" }, note: { anyOf: [{ type: "string" }, { type: "null" }] } },
    required: ["word"],
  });
  // The next user turn continues the same process again.
  messages.push(second.message, user("HISTORY"));
  const third = await runTurn(messages);
  assert.equal(third.path, "continue");
  assert.match(text(third.message), /\[result A=35\]/u);
});

test("without tool_use ids in MCP metadata, parked calls keep their order-and-name correlation", async () => {
  process.env.FAKE_CLAUDE_NO_TOOL_META = "1";
  try {
    const messages: Message[] = [user('CALL lookup {"word":"alpha"}\nCALL lookup {"word":"beta"}')];
    const first = await runTurn(messages);
    assert.equal(first.message.stopReason, "toolUse", first.message.errorMessage);
    const calls = callsOf(first.message);
    // Let the first MCP call reach the bridge and park before Pi's results arrive.
    for (let i = 0; i < 100 && !readLog(log).some((entry) => entry.event === "tool_call"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    messages.push(first.message, toolResult(calls[0]!, "A=35"), toolResult(calls[1]!, "B=28"));
    const second = await runTurn(messages);
    assert.equal(second.path, "tool-results");
    assert.equal(text(second.message), "tool results: [result A=35] [result B=28]");
  } finally {
    delete process.env.FAKE_CLAUDE_NO_TOOL_META;
  }
});

test("tool results followed by a steering message fork at the tool call and send both", async () => {
  const messages: Message[] = [user('CALL lookup {"word":"gamma"}')];
  const first = await runTurn(messages);
  const [call] = callsOf(first.message);
  messages.push(first.message, toolResult(call!, "G=5"), user("HISTORY steer"));
  const second = await runTurn(messages);
  assert.equal(second.path, "fork", second.message.errorMessage);
  const seen = JSON.parse(text(second.message)) as string[];
  assert.deepEqual(seen.slice(0, 2), ['u:CALL lookup {"word":"gamma"}', "a:[tool_use]"]);
  assert.equal(seen.at(-1), "u:[result G=5] HISTORY steer");
  assert.equal(manager.workers().length, 1);
});

test("a /tree branch forks the Claude Code session at the last shared entry", async () => {
  const main: Message[] = [user("one")];
  const a1 = await runTurn(main);
  main.push(a1.message, user("two"));
  const a2 = await runTurn(main);
  main.push(a2.message);
  const branch: Message[] = [main[0]!, a1.message, user("HISTORY branch")];
  const forked = await runTurn(branch);
  assert.equal(forked.path, "fork");
  assert.deepEqual(JSON.parse(text(forked.message)), ["u:one", "a:echo: one", "u:HISTORY branch"]);
  const forkStart = starts().at(-1)!;
  assert.ok(forkStart.args!.includes("--fork-session"));
  assert.ok(forkStart.args!.includes("--resume-session-at"));
  // Back on the main branch: fork again, with main's history intact.
  main.push(user("HISTORY main"));
  const back = await runTurn(main);
  assert.equal(back.path, "fork");
  assert.deepEqual(JSON.parse(text(back.message)), ["u:one", "a:echo: one", "u:two", "a:echo: two", "u:HISTORY main"]);
});

test("history Claude Code never saw is synthesized as a transcript and resumed", async () => {
  const messages: Message[] = [
    user("remember"),
    {
      ...foreignAssistant("noted"),
      content: [
        { type: "thinking", thinking: "secret reasoning", thinkingSignature: "sig-from-other-account" },
        { type: "text", text: "noted" },
        { type: "toolCall", id: "call|weird id", name: "lookup", arguments: { word: "x" } },
      ],
      stopReason: "toolUse",
    } as AssistantMessage,
    toolResult({ id: "call|weird id", name: "lookup" }, "X=7"),
    user("HISTORY"),
  ];
  const result = await runTurn(messages);
  assert.equal(result.path, "synth", result.message.errorMessage);
  assert.deepEqual(JSON.parse(text(result.message)), [
    "u:remember",
    "a:noted [tool_use]",
    "u:[result X=7] HISTORY",
  ]);
  const start = starts().at(-1)!;
  const sessionId = start.args![start.args!.indexOf("--resume") + 1]!;
  const projects = join(homedir(), ".claude", "projects");
  const dir = readdirSync(projects).map((name) => join(projects, name)).find((path) => existsSync(join(path, `${sessionId}.jsonl`)));
  assert.ok(dir, "synthesized transcript written into Claude Code's project directory");
});

test("aborting a turn interrupts Claude Code and the next turn forks from the last good entry", async () => {
  const messages: Message[] = [user("first")];
  const first = await runTurn(messages);
  messages.push(first.message, user("SLOW"));
  const aborted = await runTurn(messages, { abortAfterFirstDelta: true });
  assert.equal(aborted.message.stopReason, "aborted");
  assert.equal(manager.workers().length, 0);
  messages.push(aborted.message, user("HISTORY"));
  const next = await runTurn(messages);
  assert.equal(next.path, "fork", next.message.errorMessage);
  assert.deepEqual(JSON.parse(text(next.message)), ["u:first", "a:echo: first", "u:SLOW", "u:HISTORY"]);
});

test("changing the thinking level forks with the new effort", async () => {
  const messages: Message[] = [user("one")];
  const first = await runTurn(messages, { reasoning: "low" });
  messages.push(first.message, user("two"));
  const second = await runTurn(messages, { reasoning: "high" });
  assert.equal(second.path, "fork");
  assert.deepEqual(requests().map((entry) => entry.effort), ["low", "high"]);
});

test("anchors stored on assistant messages let a new Pi process fork instead of synthesizing", async () => {
  const messages: Message[] = [user("one")];
  const first = await runTurn(messages);
  messages.push(first.message, user("HISTORY"));
  await manager.closeAll();
  const resumed = await runTurn(messages, { sessionId: "pi-session-restarted" });
  assert.equal(resumed.path, "fork");
  assert.deepEqual(JSON.parse(text(resumed.message)), ["u:one", "a:echo: one", "u:HISTORY"]);
});

test("an anchor whose Claude Code session is gone falls back to synthesis", async () => {
  const messages: Message[] = [user("one")];
  const first = await runTurn(messages);
  messages.push(first.message, user("HISTORY"));
  await manager.closeAll();
  rmSync(join(homedir(), ".claude", "projects"), { recursive: true, force: true });
  const resumed = await runTurn(messages, { sessionId: "pi-session-gone" });
  assert.equal(resumed.path, "synth", resumed.message.errorMessage);
  assert.deepEqual(JSON.parse(text(resumed.message)), ["u:one", "a:echo: one", "u:HISTORY"]);
});

test("a response charged to usage credits fails as a non-retryable billing error", async () => {
  const result = await runTurn([user("OVERAGE")]);
  assert.equal(result.message.stopReason, "error");
  assert.match(result.message.errorMessage!, /billing/u);
  assert.match(result.message.errorMessage!, /usage credits/u);
});

test("inherited API keys and base URLs are refused before Claude Code starts", async () => {
  process.env.ANTHROPIC_API_KEY = "test-not-a-key";
  try {
    const result = await runTurn([user("hello")]);
    assert.equal(result.message.stopReason, "error");
    assert.match(result.message.errorMessage!, /ANTHROPIC_API_KEY/u);
    assert.equal(starts().length, 0);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});
