import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoPermissionsConfig } from "./config.js";
import type { Gate } from "./gates.js";

/** What a permission decision hands back to Pi to stop the tool call. */
export type BlockResult = { block: true; reason: string };

/** The tool call a review belongs to, and the row it may render in. */
export interface ReviewTarget {
  toolName: string;
  toolCallId?: string;
}

/**
 * Everything one gated command is judged against, built once per `tool_call`
 * (and per `request_override`) and passed whole to the display, the reviewer,
 * the denial log and the approval prompt — so those five never disagree about
 * which command, gate or config they are talking about.
 */
export interface ReviewScope {
  ctx: ExtensionContext;
  config: AutoPermissionsConfig;
  gate: Gate;
  command: string;
  target: ReviewTarget;
}
