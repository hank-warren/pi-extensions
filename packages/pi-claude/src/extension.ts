import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { removePrivateDirectorySync } from "./bridge.ts";
import { sweepCreatedSessions } from "./cleanup.ts";
import { claudeSubEnv, createClaudeSubscriptionProvider } from "./provider.ts";
import { formatStatus } from "./status.ts";
import { manager } from "./stream.ts";
import { getClaudeStatus } from "./claude-cli.ts";

let processHooksInstalled = false;
let unregisterCleanup: (() => void) | undefined;

export default function claudeSubscriptionExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createClaudeSubscriptionProvider());

  pi.registerCommand("claude-sub-status", {
    description: "Claude subscription provider: Claude Code login, threads, live processes and recent turns",
    handler: async (_args, ctx) => {
      const status = await getClaudeStatus(claudeSubEnv(), ctx.signal);
      ctx.ui.notify(formatStatus(status, manager, claudeSubEnv()), status.loggedIn && status.subscription ? "info" : "error");
    },
  });

  pi.on("session_shutdown", async () => {
    await manager.closeAll();
  });

  unregisterCleanup?.();
  unregisterCleanup = registerSessionResourceCleanup((sessionId) => {
    void (sessionId ? manager.closeSession(sessionId) : manager.closeAll());
  });

  if (!processHooksInstalled) {
    processHooksInstalled = true;
    process.once("exit", () => {
      manager.killAll();
      removePrivateDirectorySync();
    });
    void sweepCreatedSessions().catch(() => undefined);
  }
}
