/**
 * Public event contract for @hank-warren/pi-ask-user-question.
 *
 * STABILITY POLICY — applies to every event in the `hank:*` namespace.
 *
 *   1. Channel names are immutable. Once shipped, never rename.
 *   2. Payload changes are append-only. Listeners MUST tolerate unknown
 *      fields. New fields ship as optional (`?:`).
 *   3. Breaking changes (rename, retype, remove a field; change emission
 *      semantics) require a NEW channel, e.g. `hank:ask-user:prompt.v2`,
 *      with dual-emit during a deprecation window.
 *   4. No `version` field inside payloads. Version via channel name only.
 *   5. Payloads must be JSON-safe: primitives, arrays, plain objects. No
 *      Set/Map/Date/class instances — payloads must survive JSON
 *      serialization when listeners forward them across process boundaries.
 *
 * Intended consumers: pi-statusline (blocked-on-human indicator) and
 * pi-auto-permissions (suppress guardian nags while a human is being asked).
 */

/** Emitted once when a questionnaire is presented. */
export const ASK_USER_PROMPT_EVENT = "hank:ask-user:prompt" as const;

export interface AskUserPromptOption {
	label: string;
	description: string;
}

export interface AskUserPromptQuestion {
	question: string;
	header: string;
	/**
	 * True when the question renders as checkboxes. Emitted only when true, so
	 * existing listeners see the payload they already knew (policy rule 2:
	 * append-only, new fields optional).
	 */
	multiSelect?: boolean;
	options: ReadonlyArray<AskUserPromptOption>;
}

export interface AskUserPromptEventPayload {
	questions: ReadonlyArray<AskUserPromptQuestion>;
}

/**
 * Emitted while the questionnaire awaits input, and cleared with
 * `{ active: false }` in a `finally` so listeners can always distinguish
 * blocked-on-human from working — including when the dialog throws.
 */
export const ASK_USER_BLOCKED_EVENT = "hank:ask-user:blocked" as const;

export interface AskUserBlockedEventPayload {
	/** True while input is awaited; false when the wait ends (answer, cancel, or error). */
	active: boolean;
}

/** Emitted after the active tool set has been reconciled for the current run. */
export const ASK_USER_AVAILABILITY_EVENT = "hank:ask-user:availability" as const;

export interface AskUserAvailabilityEventPayload {
	/** True only when an interactive global question tool is active and usable. */
	available: boolean;
}
