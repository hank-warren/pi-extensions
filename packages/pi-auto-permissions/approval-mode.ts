/**
 * Approval modes: what happens when the guardian cannot approve a command on
 * its own (an "ask_user" verdict, or a review that failed).
 *
 * `auto` mirrors Claude Code's auto mode: the command is blocked with the
 * reason, the agent keeps working and asks in its reply, and a later user
 * message naming the operation approves it at the next review. A live prompt
 * appears only as a fallback, after BLOCKS_IN_A_ROW blocks without an approval
 * in between or BLOCKS_TOTAL in the session — the agent is stuck, and asking
 * beats flailing. `careful` prompts at once. `afk` never prompts.
 */

import type { ApprovalMode } from "./config.js";

export const BLOCKS_IN_A_ROW = 3;
export const BLOCKS_TOTAL = 20;

/** Counts blocks for the `auto` fallback. One per session. */
export class BlockCounter {
  private inARow = 0;
  private total = 0;

  /** An approval breaks a run of blocks; the session total stays. */
  approved(): void {
    this.inARow = 0;
  }

  /**
   * Record one more block. Returns the reason to fall back to a live prompt
   * instead, resetting the counter that tripped, or undefined to block.
   */
  next(): string | undefined {
    if (this.inARow + 1 >= BLOCKS_IN_A_ROW) {
      this.inARow = 0;
      return `${BLOCKS_IN_A_ROW} blocks in a row`;
    }
    if (this.total + 1 >= BLOCKS_TOTAL) {
      this.inARow = 0;
      this.total = 0;
      return `${BLOCKS_TOTAL} blocks this session`;
    }
    this.inARow += 1;
    this.total += 1;
    return undefined;
  }

  reset(): void {
    this.inARow = 0;
    this.total = 0;
  }
}

const FAILED_REVIEW_NOTE = "The review itself failed, so running the same command again later may succeed.";

/** What the agent is told when `auto` blocks a command. */
export function autoBlockReason(gateLabel: string, reason: string, failed: boolean): string {
  return `${gateLabel} was blocked by Auto Permissions: ${reason}
${failed ? `${FAILED_REVIEW_NOTE} ` : "Do not retry it unchanged. "}Carry on with the parts of the task that do not need it, or get the same result another way. If it is genuinely required, finish what you can, then name the exact command in your final message and ask the user to approve it; it is reviewed again once they reply.`;
}

/** What the agent is told when `afk` blocks a command. */
export function afkBlockReason(gateLabel: string, reason: string, failed: boolean): string {
  return `${gateLabel} was blocked by Auto Permissions: ${reason}
The user is away, so nothing is sent to them now. ${failed ? `${FAILED_REVIEW_NOTE} ` : "Do not retry it unchanged. "}Carry on with the rest of the task or get the same result another way, and list this command and why it is needed in your final message so the user can approve it when they are back.`;
}

/** The system prompt section that carries AFK_PERMISSIONS_PROMPT on Pi versions with a structured prompt. */
export const AFK_PROMPT_SECTION = "auto_permissions_afk";

export const AFK_PERMISSIONS_PROMPT = `## Auto Permissions (user away)
The user is away. Bash commands that Auto Permissions cannot approve on its own are blocked, not sent to them. When one is blocked, do not retry it unchanged: carry on with the rest of the task or get the result another way. In your final message, list each blocked command and why it is needed, so the user can approve it when they are back.`;

/** Footer status text for a mode, or undefined for the default. */
export function approvalModeStatus(mode: ApprovalMode): string | undefined {
  if (mode === "careful") return "permissions: careful";
  if (mode === "afk") return "permissions: afk";
  return undefined;
}
