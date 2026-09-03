/**
 * Consumer-side mirror of the one session-entry contract pi-loop still
 * depends on.
 *
 * pi-loop reads `plan-mode-state` from @hank-warren/pi-plan-mode and never
 * writes it. The sequence below is a literal copy of what that producer
 * actually emits, pinned on the producer side by
 * `packages/pi-plan-mode/test/plan-mode.test.ts` ->
 * `"plan-mode-state entry shape (pi-loop consumer contract)"`.
 *
 * It is duplicated rather than imported on purpose. Public packages may not
 * import a sibling package's source (repo `AGENTS.md`, Conventions), so this
 * is the same discipline `DUPLICATED_SOURCES` enforces for shared code: two
 * self-contained copies, each naming the other. When the producer test
 * changes, change this file in the same pull request.
 *
 * Why this exists at all: pi-loop's fixtures once *invented* a producer's
 * contract instead of copying it, and the loop then misread a real entry
 * sequence in production. Fixtures here must be transcribed from the
 * producer, never assumed.
 */

export type SessionEntry = { type: string; customType?: string; data?: unknown };

const PLAN_MODE_STATE = "plan-mode-state";

export function planModeStateEntry(enabled: unknown): SessionEntry {
	return { type: "custom", customType: PLAN_MODE_STATE, data: { enabled } };
}

/** Plan mode entered, then exited: the newest entry wins, `enabled` is a boolean. */
export const PLAN_MODE_ENTER_EXIT_SEQUENCE: SessionEntry[] = [
	planModeStateEntry(true),
	planModeStateEntry(false),
];
