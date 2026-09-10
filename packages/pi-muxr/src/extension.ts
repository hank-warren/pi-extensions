/**
 * The muxr Pi extension: a read client of the muxr bridge.
 *
 * Voluntary registration and a read projection. It registers no tool and no
 * command, and every event handler returns `undefined`, so a handler return
 * value can never rewrite what Pi persists ($PI/docs/extensions.md,
 * "message_end": a handler that returns `{ message }` replaces the finalized
 * message). It never touches Herdr: no import, no focus call, no layout
 * mutation.
 *
 * The bridge is the sole Unix listener; this extension is the client. It
 * learns the socket path, its one-use capability file, its registration id and
 * its binding file from **registered CLI flags**, never from a default path
 * and never from the environment. With any of them absent the extension is
 * inert: it registers its flags and does nothing else.
 *
 * The one write path, chat write, is a gated prototype — see `chat-write.ts`
 * and `UPSTREAM-PROPOSAL.md`. It is off unless the user's setting, the CLI
 * flag, and the bridge's capability request all agree.
 */

import { readFileSync } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	ChatWriteBindingError,
	createChatWriteController,
	parseChatWriteEnvelope,
} from "./chat-write.ts";
import type { ChatWriteController } from "./chat-write.ts";
import {
	CHAT_WRITE_CAPABILITY,
	CHAT_WRITE_FLAG,
	consentRefusalReason,
	evaluateChatWriteConsent,
} from "./consent.ts";
import { BINDING_SHAPE, PROTOCOL, assertShape } from "./contracts.ts";
import { createPiProjection, extractText } from "./projection.ts";
import type { PiProjection } from "./projection.ts";
import { handshake, openConnection } from "./wire.ts";
import type { Connection, Envelope } from "./wire.ts";

/** Options for every `sendUserMessage` this extension issues. See its use below. */
const SEND_OPTIONS = Object.freeze({ expandPromptTemplates: false });

type SendUserMessageOptions = Parameters<ExtensionAPI["sendUserMessage"]>[1];

/** Flags the bridge must pass. No default path is consulted for any of them. */
export const FLAGS = Object.freeze({
	capabilityFile: "muxr-capability-file",
	bridgeSocket: "muxr-bridge-socket",
	registrationId: "muxr-registration-id",
	bindingFile: "muxr-binding-file",
	experimentalChatWrite: CHAT_WRITE_FLAG,
});

/**
 * Herdr-side subset of `BINDING_SHAPE`.
 *
 * The binding file may only supply these. The Pi-side fields are read from the
 * live session after the spread, so the file can never forge session identity.
 */
const BINDING_FILE_SHAPE = Object.freeze(
	Object.fromEntries(Object.entries(BINDING_SHAPE).filter(([key]) => !key.startsWith("pi"))),
);

/**
 * Re-registration policy after the bridge goes away.
 *
 * The capability is one-use and cannot authorize a reconnect, so every attempt
 * re-reads the file: the bridge must have written a fresh capability. Attempts
 * are bounded so the extension never spins.
 */
const RECONNECT_ATTEMPTS = 40;
const RECONNECT_DELAY_MS = 50;

/**
 * Read the Herdr-side binding tuple the bridge recorded.
 *
 * Validated before the capability is spent, so a malformed file refuses
 * registration instead of failing later inside `snapshot()`.
 */
function readBinding(path: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(
			`muxr: binding file is not readable JSON (${
				error instanceof Error ? error.message : String(error)
			})`,
		);
	}
	return assertShape(parsed, BINDING_FILE_SHAPE, "bindingFile");
}

export default function muxrExtension(pi: ExtensionAPI): void {
	for (const name of Object.values(FLAGS)) {
		if (name === CHAT_WRITE_FLAG) continue;
		pi.registerFlag(name, {
			description: `muxr bridge: ${name.replace(/^muxr-/, "").replace(/-/g, " ")}`,
			type: "string",
		});
	}
	pi.registerFlag(CHAT_WRITE_FLAG, {
		description:
			"muxr: allow the bridge to send chat messages (experimental; also requires the muxr.experimentalChatWrite setting)",
		type: "boolean",
		default: false,
	});

	let connection: Connection | null = null;
	let projection: PiProjection | null = null;
	let chatWrite: ChatWriteController | null = null;
	let runtimeGeneration = 0;
	let bridgeRequestedChatWrite = false;
	/** Registration a `chat_write` must name to be honoured. */
	let liveRegistration: { registrationId: string; bridgeEpoch: number } | null = null;
	let stopped = false;
	let reconnecting = false;
	/** Latest context, so a reconnect can publish a snapshot outside a handler. */
	let sessionContext: ExtensionContext | null = null;

	const stringFlag = (name: string): string | null => {
		const value = pi.getFlag(name);
		return typeof value === "string" && value.length > 0 ? value : null;
	};

	/**
	 * Send an envelope, tolerating a bridge that has gone away: the connection
	 * is the hint channel, and the snapshot after reconnect is authoritative.
	 */
	const emit = (envelope: Envelope | null | undefined): void => {
		if (!envelope || !connection) return;
		try {
			connection.send(envelope);
		} catch {
			connection = null;
		}
	};

	/** Evaluate the three chat-write gates against the live context. */
	const checkConsent = (): { enabled: boolean; reason?: string } => {
		const ctx = sessionContext;
		if (!ctx) return { enabled: false, reason: "chat_write_disabled:capability" };
		const decision = evaluateChatWriteConsent({
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
			flagPresent: pi.getFlag(CHAT_WRITE_FLAG) === true,
			bridgeRequested: bridgeRequestedChatWrite,
		});
		return decision.enabled
			? { enabled: true }
			: { enabled: false, reason: consentRefusalReason(decision.missing) };
	};

	/** Handle one inbound envelope from the bridge. Never throws. */
	const handleInbound = (envelope: Envelope): void => {
		try {
			if (envelope.kind !== "chat_write") return;
			if (!chatWrite || !sessionContext || !liveRegistration) return;
			const request = parseChatWriteEnvelope(envelope, liveRegistration);
			chatWrite.request(request, sessionContext);
		} catch (error) {
			// A request that does not belong to this registration is refused by
			// name, so the bridge learns which binding check failed.
			if (error instanceof ChatWriteBindingError && projection) {
				emit(
					projection.chatWriteResult({
						requestId: error.requestId,
						state: "rejected",
						reason: error.reason,
					}),
				);
				return;
			}
			// A malformed envelope is dropped: the reader already validated its
			// shape, and throwing here would surface as an uncaught exception in a
			// socket callback and take down the observed session.
		}
	};

	/** Register with the bridge and publish the first authoritative snapshot. */
	const register = async (ctx: ExtensionContext): Promise<void> => {
		const socketPath = stringFlag(FLAGS.bridgeSocket);
		const capabilityFile = stringFlag(FLAGS.capabilityFile);
		const registrationId = stringFlag(FLAGS.registrationId);
		const bindingFile = stringFlag(FLAGS.bindingFile);
		if (!socketPath || !capabilityFile || !registrationId || !bindingFile) return;

		// Validated before a socket is opened or a capability is spent.
		const herdrBinding = readBinding(bindingFile);

		const next = await openConnection(socketPath);
		let registered: Envelope;
		try {
			registered = await handshake(next, {
				capabilityFile,
				registrationId,
				piVersion: PROTOCOL.piVersion,
			});
		} catch (error) {
			// Without this the socket leaks once per bounded retry.
			next.close();
			throw error;
		}

		// Only a completed registration is a new runtime generation; counting
		// attempts would inflate the binding on every retry.
		runtimeGeneration += 1;

		const requested = registered.requestedCapabilities;
		bridgeRequestedChatWrite =
			Array.isArray(requested) && requested.includes(CHAT_WRITE_CAPABILITY);

		const sessionManager = ctx.sessionManager;
		const binding = {
			...herdrBinding,
			piRuntimeGeneration: runtimeGeneration,
			piSessionId: sessionManager.getSessionId(),
			piLeafId: sessionManager.getLeafId() ?? "",
		};

		connection = next;
		liveRegistration = {
			registrationId,
			bridgeEpoch: registered.bridgeEpoch as number,
		};
		const activeProjection = createPiProjection({
			binding,
			bridgeEpoch: registered.bridgeEpoch as number,
			registrationId,
			protocol: PROTOCOL.bridge,
			bindingRevision: registered.bindingRevision as number,
		});
		projection = activeProjection;
		chatWrite = createChatWriteController({
			// Remote text is the least trusted input in the system, so command
			// dispatch and template expansion are refused explicitly rather than
			// left to an upstream default. Pi already defaults this to false
			// (dist/core/agent-session.js: `options?.expandPromptTemplates ?? false`);
			// saying so here means a future default flip cannot silently start
			// dispatching `/`-prefixed remote text as an extension command.
			//
			// The cast is a typings-only version skew: the option ships in Pi
			// 0.85.1 (the runtime baseline, and what PROTOCOL.piVersion pins) but
			// not in the 0.84 typings this workspace resolves for its devDependency.
			// An older runtime ignores the unknown key, so the cast cannot break one.
			send: (text) => pi.sendUserMessage(text, SEND_OPTIONS as SendUserMessageOptions),
			emit: (result) => emit(activeProjection.chatWriteResult(result)),
			getRuntimeGeneration: () => runtimeGeneration,
			checkConsent,
		});

		next.onEnvelope(handleInbound);
		next.onClose(() => {
			connection = null;
			// A pending write may already have landed, so the client is told
			// `unknown` and reconciles against the next snapshot.
			chatWrite?.abandon("connection_closed");
			chatWrite = null;
			liveRegistration = null;
			// Provisional ids belong to the connection that observed them: the
			// snapshot published after re-registration is authoritative instead.
			activeProjection.resetProvisional();
			projection = null;
			bridgeRequestedChatWrite = false;
			scheduleReconnect();
		});

		emit(
			activeProjection.snapshot({
				sessionManager,
				lifecycle: "live",
				chatWriteEnabled: checkConsent().enabled,
			}),
		);
	};

	/**
	 * Re-register after the bridge goes away, using a freshly written
	 * capability. Timers are unrefed so a pending retry can never keep the
	 * process alive past its work.
	 */
	function scheduleReconnect(): void {
		if (stopped || reconnecting) return;
		reconnecting = true;
		void (async () => {
			for (let attempt = 0; attempt < RECONNECT_ATTEMPTS; attempt += 1) {
				if (stopped) break;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, RECONNECT_DELAY_MS);
					timer.unref?.();
				});
				if (stopped || connection || !sessionContext) continue;
				try {
					await register(sessionContext);
					break;
				} catch {
					// Bridge still absent or the capability is not usable yet;
					// retry until the bounded attempts run out, then stay
					// disconnected until the next session event.
				}
			}
			reconnecting = false;
		})();
	}

	pi.on("session_start", async (_event, ctx) => {
		if (stopped) return;
		sessionContext = ctx;
		await register(ctx);
	});

	pi.on("message_start", async (event) => {
		const role = event.message?.role;
		// A user message is evidence for a pending chat write, never a
		// provisional projection entry: the persisted entry is what the snapshot
		// carries, and inventing a provisional id for it would create identity
		// the reconciler would then have to remove.
		if (role === "user") {
			if (sessionContext) {
				chatWrite?.observeMessageStart(event.message as { role?: unknown }, sessionContext);
			}
			return;
		}
		if (role !== "assistant") return;
		emit(projection?.messageStart({ role }));
	});

	pi.on("message_update", async (event) => {
		const streamEvent = event.assistantMessageEvent as
			| { type?: string; delta?: unknown }
			| undefined;
		if (streamEvent?.type !== "text_delta" || typeof streamEvent.delta !== "string") return;
		emit(projection?.messageUpdate({ delta: streamEvent.delta }));
	});

	pi.on("message_end", async (event) => {
		const role = event.message?.role;
		if (role !== "assistant") return;
		// Observed, never replaced: returning a message here would rewrite what
		// Pi persists.
		emit(projection?.messageEnd({ role, text: extractText(event.message.content) }));
	});

	pi.on("tool_execution_start", async (event) => {
		emit(
			projection?.toolEvent("tool_execution_start", {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
			}),
		);
	});

	pi.on("tool_execution_end", async (event) => {
		emit(
			projection?.toolEvent("tool_execution_end", {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: Boolean(event.isError),
			}),
		);
	});

	/**
	 * Reconcile provisional ids against persisted entries, then republish the
	 * authoritative snapshot.
	 */
	const settle = (ctx: ExtensionContext, lifecycle: string): void => {
		sessionContext = ctx;
		chatWrite?.resolve(ctx);
		if (!projection) return;
		// The mapping is its own `message_reconciled` event, never a fabricated
		// tool event: a `provisional:N` id is not a tool call, and inventing
		// `tool_execution_end` makes a consumer render phantom tool cards.
		const reconciled = projection.reconcile(ctx.sessionManager);
		emit(projection.reconciledEvent(reconciled));
		emit(
			projection.snapshot({
				sessionManager: ctx.sessionManager,
				lifecycle,
				chatWriteEnabled: checkConsent().enabled,
			}),
		);
	};

	pi.on("turn_end", async (_event, ctx) => {
		settle(ctx, "live");
	});

	pi.on("agent_settled", async (_event, ctx) => {
		settle(ctx, "settled");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopped = true;
		chatWrite?.abandon("session_shutdown");
		chatWrite = null;
		liveRegistration = null;
		if (projection && connection) {
			emit(
				projection.snapshot({
					sessionManager: ctx.sessionManager,
					lifecycle: "ended",
					chatWriteEnabled: checkConsent().enabled,
				}),
			);
		}
		connection?.close();
		connection = null;
		projection = null;
	});
}
