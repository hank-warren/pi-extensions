/**
 * Canonical form of the muxr contracts, for the cross-repo parity guard.
 *
 * This algorithm must stay identical to `packages/contracts/src/canonical.ts`
 * in hank-warren/muxr; the whole point of the guard is that both sides reduce
 * their contracts to the same bytes. It is duplicated rather than imported
 * because the two live in different repositories and this package must not
 * depend on that one at build or test time.
 *
 * It lives under `test/support/` rather than in `src/` because it is a guard, not
 * runtime code: nothing the extension does at runtime needs it, and keeping it
 * here keeps it out of the published tarball. `scripts/refresh-muxr-contracts.mjs`
 * imports it through `tsx`, the same loader the test suite uses.
 */

/**
 * Exports every consumer of this wire must match exactly.
 *
 * `LIMITS` is deliberately absent: only the subset in {@link WIRE_LIMIT_KEYS}
 * is wire-relevant, and demanding whole-object identity would force each
 * consumer to carry numbers it has no use for.
 */
export const WIRE_EXPORTS = Object.freeze([
	"PROTOCOL",
	"CAPABILITIES",
	"DISABLED",
	"ROLES",
	"MESSAGE_KINDS",
	"ERROR_CODES",
	"PI_EVENT_TYPES",
	"HERDR_EVENT_TYPES",
	"MUXR_EVENT_TYPES",
	"EVENT_TYPES",
	"LIFECYCLE_STATES",
	"CONVERSATION_ROLES",
	"CHAT_WRITE_STATES",
	"DISABLED_SHAPE",
	"BINDING_SHAPE",
	"CONVERSATION_ENTRY_SHAPE",
	"MESSAGE_RECONCILED_PAYLOAD_SHAPE",
	"CHAT_WRITE_RESULT_PAYLOAD_SHAPE",
	"HELLO_SHAPE",
	"CHALLENGE_SHAPE",
	"RESPONSE_SHAPE",
	"REGISTERED_SHAPE",
	"SNAPSHOT_SHAPE",
	"EVENT_SHAPE",
	"ERROR_SHAPE",
	"CHAT_WRITE_SHAPE",
	"ENVELOPE_SHAPES",
]);

/** The `LIMITS` keys that actually cross the wire. */
export const WIRE_LIMIT_KEYS = Object.freeze([
	"events",
	"totalBytes",
	"frameBytes",
	"capabilityTtlMs",
]);

/** Proof/bridge-side exports; the extension may waive these key by key. */
export const HOST_EXPORTS = Object.freeze([
	"CURSORS",
	"TERMINAL_LEASE_OWNERS",
	"TERMINAL_LEASE_PAYLOAD_SHAPE",
	"LAUNCH_RECORD_HERDR_SHAPE",
	"LAUNCH_RECORD_SHAPE",
]);

/**
 * Recursively key-sorted, array-order-preserving JSON.
 *
 * **Array order is semantic and is never sorted.** `MESSAGE_KINDS` and
 * `EVENT_TYPES` order is asserted by the proof's own tests. Only object keys
 * are normalised, so a shape written `{a, b}` and `{b, a}` compare equal —
 * which makes this a *contract* digest rather than a formatting digest.
 */
export function canonicalize(value: unknown): string {
	return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalize);
	if (value === null || typeof value !== "object") return value;
	const source = value as Record<string, unknown>;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(source).sort()) {
		sorted[key] = normalize(source[key]);
	}
	return sorted;
}

/**
 * Project a contracts module down to a named export set.
 *
 * A missing name is an error rather than a silent omission: a guard that
 * quietly skips a renamed export proves nothing.
 */
export function canonicalContract(
	module: Record<string, unknown>,
	names: readonly string[],
): Record<string, unknown> {
	const projected: Record<string, unknown> = {};
	for (const name of names) {
		if (!Object.hasOwn(module, name)) {
			throw new Error(`canonicalContract: module is missing export ${name}`);
		}
		projected[name] = module[name];
	}
	return projected;
}

/**
 * Project the wire-relevant subset of a `LIMITS` object.
 */
export function canonicalLimits(limits: Record<string, unknown>): Record<string, unknown> {
	const projected: Record<string, unknown> = {};
	for (const key of WIRE_LIMIT_KEYS) {
		if (!Object.hasOwn(limits, key)) {
			throw new Error(`canonicalLimits: LIMITS is missing key ${key}`);
		}
		projected[key] = limits[key];
	}
	return projected;
}

/**
 * Build the wire scope alone.
 *
 * Separate from {@link buildCanonical} because a consumer may legitimately
 * waive a host-scope export (the extension never reads a launch record), and
 * demanding the host scope just to compare the wire would make that impossible.
 */
export function buildWire(module: Record<string, unknown>): Record<string, unknown> {
	return {
		...canonicalContract(module, WIRE_EXPORTS),
		LIMITS: canonicalLimits(module.LIMITS as Record<string, unknown>),
	};
}

/**
 * Build both scopes from one contracts module.
 *
 * Used by the refresh script against muxr, which carries every host export.
 *}
 */
export function buildCanonical(module: Record<string, unknown>): {
	wire: Record<string, unknown>;
	host: Record<string, unknown>;
} {
	return {
		wire: buildWire(module),
		host: canonicalContract(module, HOST_EXPORTS),
	};
}
