/**
 * `plan_implemented`: the model's way to say the approved plan is done.
 *
 * Without it the active-plan pointer and the `▶ plan · implementing` widget
 * stayed up until the user cleared them by hand, because nothing could tell
 * when implementation had ended. The tool is in the active set only while a
 * plan is active, and it joins and leaves the set at the same moments
 * `plan_mode_complete` leaves and the pointer line appears/disappears — so it
 * adds no prompt-cache invalidation of its own to the plan lifecycle.
 *
 * It takes no parameters and its description is a fixed string, so the tool
 * definition is byte-stable across turns.
 */
export const PLAN_IMPLEMENTED_TOOL_NAME = "plan_implemented";

export const PLAN_IMPLEMENTED_PARAMS = {
	type: "object",
	additionalProperties: false,
	properties: {},
} as const;

export const PLAN_IMPLEMENTED_DESCRIPTION =
	"Mark the approved implementation plan as implemented. Call it once, after the plan's verification steps have run and passed, as the final action of implementation. It archives the plan file and clears the active plan; it never edits files. Do not call it to abandon or replace a plan.";

/**
 * Appended to the Guidelines section only while the tool is active. It is the
 * one place the model learns when to end a plan, so the handoff message and
 * the pointer line can stay exactly as they were.
 */
export const PLAN_IMPLEMENTED_GUIDELINE =
	"Call plan_implemented once the approved plan's verification steps have passed, as the last action of implementation. Do not call it earlier, and do not keep re-checking whether the plan is done between steps.";

export function planImplementedResult(archivePath: string | undefined) {
	const text = archivePath
		? `Plan implemented. Archived to ${archivePath}.`
		: "Plan implemented. The plan file was already gone; the active plan is cleared.";
	return {
		content: [{ type: "text" as const, text }],
		details: { version: 1 as const, source: PLAN_IMPLEMENTED_TOOL_NAME, archivePath },
	};
}
