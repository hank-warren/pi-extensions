/**
 * Wire contracts for the muxr bridge <-> Pi extension protocol.
 *
 * Ported from `proof/lib/contracts.mjs` in hank-warren/muxr at commit
 * e5281de05f8cebdca1ee3926ef2fd3f47c47ae57 (the file itself last changed in
 * 4e0198f24b9b497cafe2a675e57356a79d5748e4). This package cannot import from
 * that repository, so the shapes are duplicated here and must stay identical:
 * the muxr bridge validates against its copy, and a divergence is a protocol
 * break.
 *
 * **That is no longer trusted to review.** `test/contract-parity.test.ts`
 * reduces this module to a canonical form and compares it against a vendored,
 * sha256-pinned copy of muxr's own artifact (`vendor/`), so a one-sided change
 * fails a test instead of shipping. Refresh with
 * `node scripts/refresh-muxr-contracts.mjs <muxr-clone> <ref>` and commit the
 * artifact, ref and digest together — that commit is the approval record.
 *
 * Any change here needs the same change there, in the same release.
 *
 * Numbers are the documented initial defaults (muxr decision 21), not derived
 * guarantees. Everything crossing this boundary is untrusted data: validation
 * fails closed, and unexpected keys are rejected rather than ignored so a peer
 * cannot smuggle fields past a reader that only looks at the ones it knows.
 */

/**
 * Baseline versions. The bridge negotiates these at runtime and fails closed
 * on mismatch; these constants are the expected values, not proof that a
 * running peer matches.
 *
 * `bridge` is the envelope version defined in this file. `herdrProtocol` is
 * Herdr's own wire protocol version. `piVersion` is the Pi baseline the read
 * projection and the chat-write source gate were established against.
 */
export const PROTOCOL = Object.freeze({
	bridge: 1,
	herdrProtocol: 22,
	piVersion: "0.85.1",
});

/**
 * Initial default bounds. Exceeding a bound fails closed: resync or refusal,
 * never truncation and never auto-repair.
 */
export const LIMITS = Object.freeze({
	events: 2048,
	totalBytes: 4 * 1024 * 1024,
	frameBytes: 1024 * 1024,
	ledgerRecords: 100000,
	ledgerBytes: 64 * 1024 * 1024,
	capabilityTtlMs: 60000,
	leaseHeartbeatMs: 5000,
	leaseExpiryMs: 15000,
});

/**
 * Independent cursors. These never collapse into one counter: output must not
 * stale a future Stop, a new run must.
 *
 * Carried for parity with the proof and the app; this package advances only
 * `eventSequence` and reads `terminalControlGeneration` off a snapshot.
 */
export const CURSORS = Object.freeze([
	"eventSequence",
	"bindingRevision",
	"expectedLeaf",
	"activeRunId",
	"terminalControlGeneration",
] as const);

/** Advertised baseline capability set. Read-only surface only. */
export const CAPABILITIES = Object.freeze(["history", "streaming"] as const);

/**
 * Capabilities that stay off unless every gate for them is satisfied.
 *
 * `chatWrite` is disabled by default because ordinary
 * `ExtensionAPI.sendUserMessage` is not an acceptance boundary: its
 * declaration is `void` ($PI/dist/core/extensions/types.d.ts:980-983), the
 * loader discards the return, and the internal path catches failures into a
 * generic runtime error. See `UPSTREAM-PROPOSAL.md`. `promptIdle` and
 * `abortExactTarget` have no target-bound atomic compare/accept contract at
 * all and are not prototyped here.
 */
export const DISABLED = Object.freeze({
	chatWrite: true,
	promptIdle: true,
	abortExactTarget: true,
});

/**
 * Shape of the `disabled` map carried on the wire.
 *
 * Polarity: `disabled.X === true` means the capability is absent. Values stay
 * `boolean` rather than pinned to `true` so an enabled capability can flip one
 * without a contract change.
 */
export const DISABLED_SHAPE: Shape = Object.freeze({
	chatWrite: { type: "boolean" },
	promptIdle: { type: "boolean" },
	abortExactTarget: { type: "boolean" },
});

/** Roles in the bridge <-> extension handshake. The bridge is the sole listener. */
export const ROLES = Object.freeze(["bridge", "extension"] as const);

/**
 * Capabilities a bridge may *ask* for beyond the baseline.
 *
 * One exported token rather than an inline literal, so `REGISTERED_SHAPE` and
 * `consent.ts` cannot drift apart. Asking is never sufficient on its own: the
 * extension additionally requires the user's setting and a CLI flag.
 */
export const REQUESTABLE_CAPABILITIES = Object.freeze(["chatWrite"] as const);

/** Envelope discriminators. */
export const MESSAGE_KINDS = Object.freeze([
	"hello",
	"challenge",
	"response",
	"registered",
	"snapshot",
	"event",
	"error",
	"chat_write",
] as const);

/**
 * Fail-closed error codes. A peer that cannot classify a failure uses
 * `internal` and treats the connection as fatal.
 */
export const ERROR_CODES = Object.freeze([
	"protocol_mismatch",
	"auth_failed",
	"capability_expired",
	"capability_consumed",
	"binding_refused",
	"epoch_mismatch",
	"sequence_gap",
	"frame_too_large",
	"buffer_overflow",
	"capability_disabled",
	"internal",
] as const);

/**
 * Pi extension events this package projects ($PI/docs/extensions.md).
 * `message_end` is provisional because later handlers can replace the
 * finalized message.
 */
export const PI_EVENT_TYPES = Object.freeze([
	"session_start",
	"session_shutdown",
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_end",
] as const);

/**
 * Herdr-derived events. Not emitted by this package; listed so an envelope
 * built by the bridge validates against the same table.
 */
export const HERDR_EVENT_TYPES = Object.freeze([
	"terminal_frame",
	"terminal_lease",
	"pane_lifecycle",
] as const);

/**
 * Events muxr itself originates. These are not Pi events and must not be added
 * to {@link PI_EVENT_TYPES}, which names events Pi actually emits.
 *
 * `message_reconciled` announces that provisional stream ids have been matched
 * to persisted session entry ids. `chat_write_result` reports the outcome of a
 * prototype chat write, including the `unknown` state that the missing
 * upstream acceptance API makes unavoidable.
 */
export const MUXR_EVENT_TYPES = Object.freeze([
	"message_reconciled",
	"chat_write_result",
] as const);

/** Every event type an envelope may carry. Unknown types fail closed. */
export const EVENT_TYPES = Object.freeze([
	...PI_EVENT_TYPES,
	...HERDR_EVENT_TYPES,
	...MUXR_EVENT_TYPES,
]);

/**
 * Terminal lease ownership. `none` means nobody holds control; `observer` means
 * read-only attachment only; `controller` means a lease-bound writer exists.
 */
export const TERMINAL_LEASE_OWNERS = Object.freeze(["none", "observer", "controller"] as const);

/**
 * Lifecycle of a bound target. `settled` is Pi idle after `agent_settled`;
 * `ended` is session shutdown; `invalidated` means the binding was replaced or
 * refused and the client must re-register rather than reuse anything.
 */
export const LIFECYCLE_STATES = Object.freeze([
	"live",
	"settled",
	"ended",
	"invalidated",
] as const);

/**
 * Outcome of a prototype chat write.
 *
 * `unknown` is a real, expected state, not an error path: the compare and the
 * send are not atomic, so a write whose acceptance cannot be confirmed must be
 * reported as unknown and surfaced to the user rather than retried.
 */
export const CHAT_WRITE_STATES = Object.freeze([
	"accepted",
	"rejected",
	"unknown",
] as const);

export type FieldType =
	| "string"
	| "number"
	| "integer"
	| "boolean"
	| "object"
	| "array";

export interface FieldSpec {
	readonly type: FieldType;
	/** Absent key is accepted when true. */
	readonly optional?: boolean;
	/** Allowed values; membership is checked. */
	readonly values?: readonly unknown[];
	/** Inclusive lower bound for `number`/`integer`. */
	readonly min?: number;
	/** Nested shape for `object`; validated recursively. */
	readonly shape?: Shape;
	/** Element spec for `array`; every element is checked. */
	readonly items?: FieldSpec;
}

export type Shape = Readonly<Record<string, FieldSpec>>;

/** Thrown by {@link assertShape}. Carries the offending key path. */
export class ShapeError extends TypeError {
	readonly path: string;

	constructor(message: string, path: string) {
		super(message);
		this.name = "ShapeError";
		this.path = path;
	}
}

/**
 * Validate a plain object against a {@link Shape}, failing closed.
 *
 * Missing required keys, unexpected extra keys, wrong types, and values
 * outside a declared `values` list all throw.
 */
export function assertShape(
	value: unknown,
	shape: Shape,
	path = "value",
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ShapeError(`${path}: expected a plain object`, path);
	}
	if (typeof shape !== "object" || shape === null) {
		throw new ShapeError(`${path}: shape must be an object`, path);
	}
	const object = value as Record<string, unknown>;

	for (const [key, spec] of Object.entries(shape)) {
		if (!Object.hasOwn(object, key)) {
			if (spec.optional) continue;
			throw new ShapeError(`${path}.${key}: missing required key`, `${path}.${key}`);
		}
		assertField(object[key], spec, `${path}.${key}`);
	}

	for (const key of Object.keys(object)) {
		if (!Object.hasOwn(shape, key)) {
			throw new ShapeError(`${path}.${key}: unexpected key`, `${path}.${key}`);
		}
	}

	return object;
}

/**
 * Validate one field, recursing into nested shapes and array elements.
 *
 * A nested object without a declared `shape` is accepted as opaque; only
 * `event.payload` uses that, and it is documented there.
 */
function assertField(value: unknown, spec: FieldSpec, path: string): void {
	switch (spec.type) {
		case "string":
			if (typeof value !== "string") throw new ShapeError(`${path}: expected string`, path);
			break;
		case "number":
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new ShapeError(`${path}: expected finite number`, path);
			}
			break;
		case "integer":
			if (!Number.isSafeInteger(value)) {
				throw new ShapeError(`${path}: expected safe integer`, path);
			}
			break;
		case "boolean":
			if (typeof value !== "boolean") throw new ShapeError(`${path}: expected boolean`, path);
			break;
		case "array":
			if (!Array.isArray(value)) throw new ShapeError(`${path}: expected array`, path);
			if (spec.items) {
				const items = spec.items;
				value.forEach((element, index) => assertField(element, items, `${path}[${index}]`));
			}
			break;
		case "object":
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				throw new ShapeError(`${path}: expected plain object`, path);
			}
			if (spec.shape) assertShape(value, spec.shape, path);
			break;
		default:
			throw new ShapeError(`${path}: unknown field type ${String(spec.type)}`, path);
	}
	if (typeof spec.min === "number" && typeof value === "number" && value < spec.min) {
		throw new ShapeError(`${path}: below minimum ${spec.min}`, path);
	}
	if (spec.values && !spec.values.includes(value)) {
		throw new ShapeError(`${path}: value not permitted`, path);
	}
}

/**
 * Target binding tuple. Every field is required: partial linkage refuses.
 */
export const BINDING_SHAPE: Shape = Object.freeze({
	hostId: { type: "string" },
	herdrServerInstance: { type: "string" },
	namedSession: { type: "string" },
	workspaceId: { type: "string" },
	tabId: { type: "string" },
	paneId: { type: "string" },
	terminalId: { type: "string" },
	herdrPaneRevision: { type: "integer", min: 0 },
	piRuntimeGeneration: { type: "integer", min: 0 },
	piSessionId: { type: "string" },
	piLeafId: { type: "string" },
});

/**
 * Roles a projected conversation entry may carry.
 *
 * `compaction` and `branch_summary` are **marker** roles, not messages: Pi
 * persists them on a branch and `buildContextEntries()` omits the entries they
 * summarize. Carrying them keeps the gap visible instead of showing a
 * conversation that silently skips history. Their `text` is the summary text.
 */
export const CONVERSATION_ROLES = Object.freeze([
	"user",
	"assistant",
	"toolResult",
	"compaction",
	"branch_summary",
] as const);

/**
 * One projected conversation entry in a snapshot. Deliberately minimal: it
 * carries identity and ordering only. `provisional` is true until a
 * post-persistence `turn_end`/`agent_settled` confirms the persisted id.
 *
 * `text` is untrusted data and is never interpreted as markup.
 */
export const CONVERSATION_ENTRY_SHAPE: Shape = Object.freeze({
	entryId: { type: "string" },
	role: { type: "string", values: CONVERSATION_ROLES },
	provisional: { type: "boolean" },
	text: { type: "string" },
	toolCallId: { type: "string", optional: true },
});

/**
 * Payload of a `message_reconciled` event.
 *
 * Carries only identity: the provisional id a consumer already rendered and
 * the persisted entry id that supersedes it. No text, because the persisted
 * text is authoritative and arrives in the next snapshot, and because matching
 * on text is rejected as an identity mechanism.
 */
export const MESSAGE_RECONCILED_PAYLOAD_SHAPE: Shape = Object.freeze({
	reconciled: {
		type: "array",
		items: {
			type: "object",
			shape: {
				provisionalId: { type: "string" },
				entryId: { type: "string" },
			},
		},
	},
});

/**
 * Payload of a `terminal_lease` event and the authority for terminal writes.
 *
 * `generation` is the `terminalControlGeneration` cursor: input is accepted
 * only for the current generation. Carried for parity and so a consumer of
 * `terminal_lease` has a declared shape to validate against; this package
 * emits Pi events only and never originates one.
 */
export const TERMINAL_LEASE_PAYLOAD_SHAPE: Shape = Object.freeze({
	generation: { type: "integer", min: 0 },
	owner: { type: "string", values: TERMINAL_LEASE_OWNERS },
	expiresAt: { type: "integer", min: 0 },
});

/**
 * Payload of a `chat_write_result` event.
 *
 * `entryId` is present only for `accepted`. `reason` is present for everything
 * except `accepted`, and is a stable machine token, never free text.
 */
export const CHAT_WRITE_RESULT_PAYLOAD_SHAPE: Shape = Object.freeze({
	requestId: { type: "string" },
	state: { type: "string", values: CHAT_WRITE_STATES },
	entryId: { type: "string", optional: true },
	reason: { type: "string", optional: true },
});

/**
 * Bridge -> extension chat write request (prototype).
 *
 * `expectedLeafId` and `expectedRuntimeGeneration` are the caller's belief
 * about the target. Both are compared before the send; a mismatch refuses.
 * They do not make the send atomic — nothing available in Pi 0.85.1 can.
 */
export const CHAT_WRITE_SHAPE: Shape = Object.freeze({
	kind: { type: "string", values: ["chat_write"] },
	protocol: { type: "integer", min: 1 },
	bridgeEpoch: { type: "integer", min: 0 },
	registrationId: { type: "string" },
	requestId: { type: "string" },
	expectedLeafId: { type: "string" },
	expectedRuntimeGeneration: { type: "integer", min: 0 },
	text: { type: "string" },
});

/**
 * Extension -> bridge opener. The extension does not yet know `bridgeEpoch`,
 * so it is absent here and established by the challenge.
 */
export const HELLO_SHAPE: Shape = Object.freeze({
	kind: { type: "string", values: ["hello"] },
	protocol: { type: "integer", min: 1 },
	role: { type: "string", values: ROLES },
	registrationId: { type: "string" },
	nonce: { type: "string" },
	piVersion: { type: "string" },
});

/**
 * Bridge -> extension challenge. `mac` proves the bridge holds the capability,
 * over a transcript binding role, protocol, epoch, registration, and both
 * nonces. Nonces are fresh 32-byte values, hex encoded.
 */
export const CHALLENGE_SHAPE: Shape = Object.freeze({
	kind: { type: "string", values: ["challenge"] },
	protocol: { type: "integer", min: 1 },
	bridgeEpoch: { type: "integer", min: 0 },
	registrationId: { type: "string" },
	nonce: { type: "string" },
	mac: { type: "string" },
});

/** Extension -> bridge proof over the same transcript. */
export const RESPONSE_SHAPE: Shape = Object.freeze({
	kind: { type: "string", values: ["response"] },
	protocol: { type: "integer", min: 1 },
	bridgeEpoch: { type: "integer", min: 0 },
	registrationId: { type: "string" },
	mac: { type: "string" },
});

/**
 * Bridge -> extension acceptance. The capability is consumed at this point and
 * cannot authorize a reconnect.
 *
 * `requestedCapabilities` is how the bridge asks for a non-baseline
 * capability. It is optional so an older bridge still registers, and asking is
 * never sufficient on its own: `chatWrite` additionally requires the user's
 * setting and the CLI flag (see `consent.ts`).
 */
export const REGISTERED_SHAPE: Shape = Object.freeze({
	kind: { type: "string", values: ["registered"] },
	protocol: { type: "integer", min: 1 },
	bridgeEpoch: { type: "integer", min: 0 },
	registrationId: { type: "string" },
	bindingRevision: { type: "integer", min: 0 },
	eventSequence: { type: "integer", min: 0 },
	capabilities: { type: "array", items: { type: "string", values: CAPABILITIES } },
	disabled: { type: "object", shape: DISABLED_SHAPE },
	requestedCapabilities: {
		type: "array",
		optional: true,
		items: { type: "string", values: REQUESTABLE_CAPABILITIES },
	},
});

/**
 * Authoritative read snapshot. Events are hints; after a gap or reconnect the
 * snapshot is rebuilt. `truncated` is true when bounded projection dropped
 * entries, so a consumer never mistakes a bounded view for a complete one.
 */
export const SNAPSHOT_SHAPE: Shape = Object.freeze({
	kind: { type: "string", values: ["snapshot"] },
	protocol: { type: "integer", min: 1 },
	bridgeEpoch: { type: "integer", min: 0 },
	registrationId: { type: "string" },
	bindingRevision: { type: "integer", min: 0 },
	eventSequence: { type: "integer", min: 0 },
	terminalControlGeneration: { type: "integer", min: 0 },
	binding: { type: "object", shape: BINDING_SHAPE },
	capabilities: { type: "array", items: { type: "string", values: CAPABILITIES } },
	disabled: { type: "object", shape: DISABLED_SHAPE },
	lifecycle: { type: "string", values: LIFECYCLE_STATES },
	entries: { type: "array", items: { type: "object", shape: CONVERSATION_ENTRY_SHAPE } },
	truncated: { type: "boolean" },
});

/**
 * Incremental hint.
 *
 * `payload` is deliberately opaque at this layer: it has no declared `shape`,
 * so `assertEnvelope` checks only that it is a plain object. Each consumer
 * validates its own payload against a declared shape before use.
 */
export const EVENT_SHAPE: Shape = Object.freeze({
	kind: { type: "string", values: ["event"] },
	protocol: { type: "integer", min: 1 },
	bridgeEpoch: { type: "integer", min: 0 },
	registrationId: { type: "string" },
	bindingRevision: { type: "integer", min: 0 },
	eventSequence: { type: "integer", min: 0 },
	type: { type: "string", values: EVENT_TYPES },
	payload: { type: "object" },
});

/**
 * Failure envelope. `bridgeEpoch` and `registrationId` are optional because a
 * pre-handshake rejection has neither. `fatal` means the connection is closed
 * and no reconnect credential exists.
 */
export const ERROR_SHAPE: Shape = Object.freeze({
	kind: { type: "string", values: ["error"] },
	protocol: { type: "integer", min: 1 },
	bridgeEpoch: { type: "integer", min: 0, optional: true },
	registrationId: { type: "string", optional: true },
	code: { type: "string", values: ERROR_CODES },
	message: { type: "string" },
	fatal: { type: "boolean" },
});

/** Envelope shape by `kind` discriminator. */
export const ENVELOPE_SHAPES: Readonly<Record<string, Shape>> = Object.freeze({
	hello: HELLO_SHAPE,
	challenge: CHALLENGE_SHAPE,
	response: RESPONSE_SHAPE,
	registered: REGISTERED_SHAPE,
	snapshot: SNAPSHOT_SHAPE,
	event: EVENT_SHAPE,
	error: ERROR_SHAPE,
	chat_write: CHAT_WRITE_SHAPE,
});

/**
 * Validate a decoded envelope by its `kind`, failing closed on an unknown or
 * missing discriminator.
 */
export function assertEnvelope(value: unknown, path = "envelope"): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ShapeError(`${path}: expected a plain object`, path);
	}
	const kind = (value as Record<string, unknown>).kind;
	if (typeof kind !== "string" || !Object.hasOwn(ENVELOPE_SHAPES, kind)) {
		throw new ShapeError(`${path}.kind: unknown envelope kind`, `${path}.kind`);
	}
	return assertShape(value, ENVELOPE_SHAPES[kind], path);
}
