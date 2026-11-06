#!/usr/bin/env node
// Fake `claude` for unit tests: emulates the parts of Claude Code's stream-json
// mode that pi-claude relies on, with no network. The "model" is scripted by the
// last user text:
//   CALL <tool> <json>   (one per line) -> tool_use blocks, then MCP tools/call, then a text reply
//   HISTORY              -> reply with the conversation it sees, as JSON
//   SLOW                 -> stream slowly until interrupted
//   OVERAGE              -> normal reply, but the rate_limit_event reports usage credits
//   anything else        -> "echo: <text>"
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name) => args.includes(name);
const log = (entry) => {
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};

if (args[0] === "auth" && args[1] === "status") {
  const plan = process.env.FAKE_CLAUDE_PLAN ?? "max";
  process.stdout.write(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_LOGGED_OUT ? false : true, authMethod: "claude.ai", apiProvider: "firstParty", ...(plan ? { subscriptionType: plan } : {}) }));
  process.exit(0);
}
if (args[0] === "--version") {
  process.stdout.write("2.1.316 (Claude Code)\n");
  process.exit(0);
}

const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const projectDir = join(configDir, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(projectDir, { recursive: true });
let model = flag("--model") ?? "default";
log({ event: "start", args });

let sessionId = flag("--session-id") ?? randomUUID();
const sessionFile = () => join(projectDir, `${sessionId}.jsonl`);
let history = [];
const resume = flag("--resume");
if (resume) {
  const file = join(projectDir, `${resume}.jsonl`);
  if (!existsSync(file)) {
    process.stderr.write(`No conversation found with session ID: ${resume}\n`);
    out({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: randomUUID() });
    process.exit(1);
  }
  const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const byUuid = new Map(entries.filter((entry) => entry.uuid).map((entry) => [entry.uuid, entry]));
  let cursor = flag("--resume-session-at") ?? entries.filter((entry) => entry.uuid).at(-1)?.uuid;
  while (cursor) {
    const entry = byUuid.get(cursor);
    if (!entry) break;
    history.unshift(entry);
    cursor = entry.parentUuid;
  }
  if (has("--fork-session")) sessionId = randomUUID();
  else sessionId = resume;
  if (has("--fork-session")) for (const entry of history) persist({ ...entry, sessionId }, false);
}
function persist(entry, push = true) {
  appendFileSync(sessionFile(), `${JSON.stringify(entry)}\n`);
  if (push) history.push(entry);
}
const leaf = () => history.at(-1)?.uuid ?? null;
function addEntry(type, message, extra = {}) {
  const entry = { parentUuid: leaf(), isSidechain: false, type, message, uuid: extra.uuid ?? randomUUID(), timestamp: new Date().toISOString(), sessionId, ...extra };
  persist(entry);
  return entry;
}

// MCP client for the configured server.
let mcp;
let mcpReady;
const mcpPending = new Map();
let mcpSeq = 0;
function mcpRequest(method, params) {
  const id = mcpSeq++;
  return new Promise((resolve) => {
    mcpPending.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
const mcpConfigArg = flag("--mcp-config");
if (mcpConfigArg) {
  const config = JSON.parse(mcpConfigArg.trim().startsWith("{") ? mcpConfigArg : readFileSync(mcpConfigArg, "utf8"));
  const server = Object.values(config.mcpServers ?? {})[0];
  if (server) {
    mcp = spawn(server.command, server.args ?? [], { env: { ...process.env, ...(server.env ?? {}) }, stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: mcp.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      mcpPending.get(message.id)?.(message.result ?? { isError: true, content: [{ type: "text", text: message.error?.message }] });
      mcpPending.delete(message.id);
    });
    mcpReady = (async () => {
      await mcpRequest("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const listed = await mcpRequest("tools/list", {});
      log({ event: "tools", tools: listed.tools });
      return listed.tools;
    })();
  }
}

let requests = 0;
let interrupted = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rateLimit = (overage) =>
  out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", isUsingOverage: overage }, session_id: sessionId, uuid: randomUUID() });

function textOf(content) {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : block.type === "tool_result" ? `[result ${typeof block.content === "string" ? block.content : block.content.map((c) => c.text ?? `[${c.type}]`).join("")}]` : `[${block.type}]`))
    .join(" ");
}

async function respond(blocks, stopReason, { slow = false, overage = false } = {}) {
  requests += 1;
  const messageId = `msg_fake_${randomUUID().slice(0, 8)}`;
  const usage = { input_tokens: 3, cache_read_input_tokens: history.length * 100, cache_creation_input_tokens: 10, output_tokens: 1, cache_creation: { ephemeral_1h_input_tokens: 10 } };
  log({ event: "request", thread: requests === 1 ? "create" : "continue", historyLength: history.length, model, effort: flag("--effort") ?? null });
  out({ type: "system", subtype: "status", status: "requesting", session_id: sessionId });
  out({ type: "stream_event", event: { type: "message_start", message: { id: messageId, model, role: "assistant", content: [], usage } }, session_id: sessionId });
  for (const [index, block] of blocks.entries()) {
    if (block.type === "text") {
      out({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "text", text: "" } }, session_id: sessionId });
      const pieces = slow ? Array.from({ length: 40 }, (_, i) => `${i},`) : [block.text];
      for (const piece of pieces) {
        if (interrupted) break;
        out({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } }, session_id: sessionId });
        if (slow) await sleep(50);
      }
      if (interrupted) return false;
    } else {
      out({ type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }, session_id: sessionId });
      out({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }, session_id: sessionId });
    }
    const entry = addEntry("assistant", { id: messageId, model, role: "assistant", type: "message", content: [block], stop_reason: null, usage });
    out({ type: "assistant", message: entry.message, uuid: entry.uuid, session_id: sessionId, parent_tool_use_id: null });
    out({ type: "stream_event", event: { type: "content_block_stop", index }, session_id: sessionId });
  }
  out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: stopReason }, usage: { ...usage, output_tokens: 7, output_tokens_details: { thinking_tokens: 2 } } }, session_id: sessionId });
  out({ type: "stream_event", event: { type: "message_stop" }, session_id: sessionId });
  rateLimit(overage);
  return true;
}

async function turn(content) {
  interrupted = false;
  const text = textOf(content);
  if (text.includes("CALL ")) {
    const calls = text
      .split("\n")
      .filter((line) => line.startsWith("CALL "))
      .map((line, index) => {
        const [, name, ...json] = line.split(" ");
        return { type: "tool_use", id: `toolu_fake_${randomUUID().slice(0, 8)}_${index}`, name: `mcp__pi__${name}`, input: JSON.parse(json.join(" ") || "{}") };
      });
    await respond(calls, "tool_use");
    await mcpReady;
    const results = [];
    for (const call of calls) {
      // FAKE_CLAUDE_NO_TOOL_META emulates Claude Code versions that omit the tool_use id.
      const meta = process.env.FAKE_CLAUDE_NO_TOOL_META ? { progressToken: 1 } : { "claudecode/toolUseId": call.id, progressToken: 1 };
      log({ event: "tool_call", id: call.id });
      const result = await mcpRequest("tools/call", { name: call.name.slice("mcp__pi__".length), arguments: call.input, _meta: meta });
      const block = { tool_use_id: call.id, type: "tool_result", content: result.content, ...(result.isError ? { is_error: true } : {}) };
      const entry = addEntry("user", { role: "user", content: [block] }, { toolUseResult: result.content });
      out({ type: "user", message: entry.message, uuid: entry.uuid, session_id: sessionId, parent_tool_use_id: null });
      results.push(textOf([block]));
    }
    await respond([{ type: "text", text: `tool results: ${results.join(" ")}` }], "end_turn");
  } else if (text.includes("HISTORY")) {
    const seen = history.filter((entry) => entry.type === "user" || entry.type === "assistant").map((entry) => `${entry.type[0]}:${textOf(entry.message.content)}`);
    await respond([{ type: "text", text: JSON.stringify(seen) }], "end_turn");
  } else if (text.includes("SLOW")) {
    const finished = await respond([{ type: "text", text: "" }], "end_turn", { slow: true });
    if (!finished) {
      out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId });
      return;
    }
  } else {
    await respond([{ type: "text", text: `echo: ${text}` }], "end_turn", { overage: text.includes("OVERAGE") });
  }
  out({ type: "result", subtype: "success", is_error: false, result: "", session_id: sessionId, modelUsage: { [model]: { contextWindow: 200000, maxOutputTokens: 64000 } } });
}

let queue = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    if (message.request?.subtype === "interrupt") interrupted = true;
    const response =
      message.request?.subtype === "initialize"
        ? { models: [{ value: "default", resolvedModel: "claude-fake-1", displayName: "Default", description: "" }, { value: "fake", resolvedModel: "claude-fake-1", displayName: "Fake 1", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"], supportsAdaptiveThinking: true, supportsThinkingOff: false }, { value: "claude-fake-small", resolvedModel: "claude-fake-small", displayName: "Fake Small", description: "", supportsThinkingOff: true }] }
        : message.request?.subtype === "get_context_usage"
          ? { rawMaxTokens: model === "claude-fake-small" ? 200000 : 1000000, model }
          : {};
    if (message.request?.subtype === "set_model") model = message.request.model;
    out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } });
    return;
  }
  if (message.type !== "user") return;
  queue = queue.then(async () => {
    out({ type: "system", subtype: "init", session_id: sessionId, model, memory_paths: { auto: `${projectDir}/memory/` }, uuid: randomUUID() });
    const entry = addEntry("user", message.message, message.uuid ? { uuid: message.uuid } : {});
    out({ type: "user", message: entry.message, uuid: entry.uuid, session_id: sessionId, parent_tool_use_id: null });
    await turn(message.message.content);
  });
});
process.stdin.on("end", () => {
  void queue.then(() => {
    mcp?.kill();
    process.exit(0);
  });
});
