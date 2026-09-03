/**
 * The loop-active environment contract.
 *
 * pi-loop publishes two variables into its own process environment while a
 * loop is active, and removes them the moment it is not:
 *
 * - `PI_LOOP_ACTIVE=1` — an unattended loop is running in this session.
 * - `PI_LOOP_ID=<id>` — the loop's id, so a reader can tell one loop from the
 *   next without asking pi-loop anything.
 *
 * It exists for other extensions, and pi-auto-permissions is the first
 * consumer: a modal permission prompt does not pause a loop, it deadlocks it,
 * so a guardian that would have asked a human needs to know there is no human
 * to ask. The mechanism is deliberately the one `pi-subagents` already
 * established with `PI_SUBAGENT_CHILD=1` and `detectSubagentContext` reads —
 * an environment variable, not a package dependency, not an import, not an
 * RPC. Neither extension needs the other installed, in either direction, and
 * a reader that never sees the variable behaves exactly as it does today.
 *
 * Both variables are set on the process, so they are visible to every
 * extension in the session and inherited by anything it spawns. That is the
 * point: a subagent launched by a looping session is running unattended for
 * the same reason its parent is.
 */

import type { LoopState } from "./state.js";

const LOOP_ACTIVE_ENV = "PI_LOOP_ACTIVE";
const LOOP_ID_ENV = "PI_LOOP_ID";

/**
 * Publish (or withdraw) the loop-active signal for `loop`.
 *
 * Only an `active` loop publishes. A paused loop is not working unattended —
 * the user paused it and is, by construction, present — and a stopped loop is
 * not working at all, so both withdraw the signal rather than leaving a stale
 * one behind for the rest of the session.
 */
export function publishLoopEnv(
	loop: LoopState | undefined,
	env: Record<string, string | undefined> = process.env,
): void {
	if (loop?.status === "active") {
		env[LOOP_ACTIVE_ENV] = "1";
		env[LOOP_ID_ENV] = loop.id;
		return;
	}
	delete env[LOOP_ACTIVE_ENV];
	delete env[LOOP_ID_ENV];
}
