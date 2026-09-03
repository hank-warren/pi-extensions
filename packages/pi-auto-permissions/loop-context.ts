/**
 * Detecting an unattended pi-loop session.
 *
 * A guardian that decides "ask_user" opens a modal and waits. In an ordinary
 * session that is the whole point — the boundary this extension exists to
 * hold. In a session running a pi-loop it is a deadlock: a session waiting on
 * a modal is `busy`, `busy` makes every loop continuation and every fallback
 * tick skip, so no turn ever completes, no cap ever trips, and nothing ends
 * the loop until it expires — up to seven days later.
 *
 * So the verdict stays exactly the same and only its *delivery* changes: the
 * guardian's concern comes back as a non-blocking block the agent can read and
 * act on, instead of a prompt nobody is there to answer. Nothing is approved
 * that would not have been approved before.
 *
 * Detection mirrors `detectSubagentContext` deliberately: an environment
 * variable, read the same way, with no import of and no dependency on the
 * extension that sets it. pi-loop publishes `PI_LOOP_ACTIVE=1` and
 * `PI_LOOP_ID` while a loop is active and removes them when it is not (see
 * `packages/pi-loop/src/loop-env.ts`). Absent that env — pi-loop not
 * installed, or installed with no loop running — behaviour is unchanged.
 */

/** Runtime facts about an active loop, forwarded to the guardian as evidence. */
export interface LoopExecutionContext {
  loop: true;
  /** The loop's id (PI_LOOP_ID), when present. */
  loopId?: string;
}

export function detectLoopContext(
  env: Record<string, string | undefined> = process.env,
): LoopExecutionContext | undefined {
  if (env.PI_LOOP_ACTIVE !== "1") return undefined;
  const context: LoopExecutionContext = { loop: true };
  // The id reaches the guardian prompt, so cap length and charset the way the
  // subagent run id is capped: an identifier, never a payload.
  const loopId = env.PI_LOOP_ID?.trim().replace(/[^\w.:-]/g, "").slice(0, 128);
  if (loopId) context.loopId = loopId;
  return context;
}
