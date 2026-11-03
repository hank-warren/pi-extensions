import test, { after } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import { createMockContext, createMockPi } from "../../../test/support/mock-pi.ts";
import extension from "../index.ts";
import { manager } from "../src/stream.ts";
import { runTurn, useFakeClaude, user } from "./support/fake.ts";

after(async () => {
  await manager.closeAll();
});

test("registers the claude-sub provider and status command, and closes workers on shutdown", async () => {
  useFakeClaude();
  const mock = createMockPi();
  extension(mock.pi as never);
  const provider = [...mock.providers.values()][0] as { id: string; name: string; getModels(): Array<{ id: string; name: string }> };
  assert.equal(provider.id, "claude-sub");
  assert.equal(provider.name, "Claude (subscription)");
  assert.ok(provider.getModels().some((model) => model.id === "claude-opus-5-5"));
  assert.ok(provider.getModels().every((model) => !/Claude Code/u.test(model.name)));
  assert.ok(mock.commands.has("claude-sub-status"));

  const messages: Message[] = [user("hello")];
  const turn = await runTurn(messages);
  assert.equal(turn.message.stopReason, "stop", turn.message.errorMessage);
  assert.equal(manager.workers().length, 1);

  const { ctx, notifications: notes } = createMockContext();
  await mock.commands.get("claude-sub-status")!.handler("", ctx);
  const note = notes.at(-1)!;
  assert.match(note.message, /Claude Code 2\.1\.316/u);
  assert.match(note.message, /logged in \(max\)/u);
  assert.match(note.message, /Message threads: on/u);
  assert.match(note.message, /Live Claude Code processes: 1/u);
  assert.match(note.message, /via fresh \(thread create\) TTFT \d+ms/u);

  for (const handler of mock.events.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
  assert.equal(manager.workers().length, 0);
});
