/**
 * Bridge transport: NDJSON framing, the handshake MAC, and the socket client.
 *
 * Ported from `proof/fixture/pi-extension.mjs` in hank-warren/muxr at commit
 * e5281de05f8cebdca1ee3926ef2fd3f47c47ae57.
 *
 * ## Wire spec (the bridge must match exactly)
 *
 * 1. **Framing.** Newline-delimited JSON: one envelope per line, UTF-8, `\n`
 *    terminated. Blank lines are ignored.
 * 2. **Line bound.** Any single line larger than `LIMITS.frameBytes` (1 MiB) is
 *    a protocol error: the reader emits `error` with code `frame_too_large`
 *    and closes. The bound is measured per line (bytes since the last `\n`),
 *    never over the accumulated buffer, so a batch of valid small lines
 *    arriving in one chunk is not rejected.
 * 3. **Transcript.** MAC input is the `|`-joined string
 *    `muxr-bridge-v1|<role>|<protocol>|<bridgeEpoch>|<registrationId>|<helloNonce>|<challengeNonce>`,
 *    where `<role>` is `bridge` for `challenge.mac` and `extension` for
 *    `response.mac`. Both nonces are fresh 32-byte values, hex encoded.
 * 4. **Key.** HMAC-SHA256 keyed by the **raw bytes** of the hex capability
 *    (`Buffer.from(capabilityHex, "hex")`), not the hex text.
 * 5. **Delivery.** Socket path, capability file path, and registration id
 *    arrive as registered Pi CLI flags, never as environment variables.
 * 6. **Reader never throws.** An unparseable line or an envelope failing shape
 *    validation closes the connection with code `internal`; retained inbound
 *    envelopes are capped at `LIMITS.totalBytes` and close with
 *    `buffer_overflow`. A throw from a `net` callback would be an uncaught
 *    exception, which JSON and print mode do not handle, and would terminate
 *    the Pi process this extension only observes. Observing must never disturb
 *    the target.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { LIMITS, PROTOCOL, assertEnvelope } from "./contracts.ts";

/** Transcript prefix binding the MAC to this protocol version. */
export const TRANSCRIPT_PREFIX = "muxr-bridge-v1";

/** A 256-bit capability, lowercase hex. Anything else is refused before use. */
export const CAPABILITY_PATTERN = /^[0-9a-f]{64}$/;

export interface Transcript {
	role: string;
	protocol: number;
	bridgeEpoch: number;
	registrationId: string;
	helloNonce: string;
	challengeNonce: string;
}

export type Envelope = Record<string, unknown>;

/**
 * Compute the handshake MAC over the canonical transcript.
 *
 * The capability is validated before it is decoded: `Buffer.from(value,
 * "hex")` silently truncates at the first non-hex character, so an
 * unvalidated short or malformed value would produce a MAC over a shorter key
 * than the caller believes.
 */
export function computeMac(capabilityHex: string, transcript: Transcript): string {
	if (!CAPABILITY_PATTERN.test(capabilityHex)) {
		throw new Error("muxr: capability must be exactly 64 lowercase hex characters");
	}
	const message = [
		TRANSCRIPT_PREFIX,
		transcript.role,
		String(transcript.protocol),
		String(transcript.bridgeEpoch),
		transcript.registrationId,
		transcript.helloNonce,
		transcript.challengeNonce,
	].join("|");
	return createHmac("sha256", Buffer.from(capabilityHex, "hex"))
		.update(message, "utf8")
		.digest("hex");
}

/** Constant-time hex comparison that never throws on a malformed peer value. */
export function macEquals(expected: string, actual: unknown): boolean {
	if (typeof actual !== "string" || actual.length !== expected.length) return false;
	const expectedBuffer = Buffer.from(expected, "hex");
	const actualBuffer = Buffer.from(actual, "hex");
	if (expectedBuffer.length !== actualBuffer.length || expectedBuffer.length === 0) return false;
	return timingSafeEqual(expectedBuffer, actualBuffer);
}

/** Read a one-use capability from its `0600` file. */
export function readCapability(path: string): string {
	const value = readFileSync(path, "utf8").trim();
	if (!CAPABILITY_PATTERN.test(value)) {
		throw new Error("muxr: capability file does not contain a 256-bit hex value");
	}
	return value;
}

export interface Connection {
	send(envelope: Envelope): void;
	next(): Promise<Envelope>;
	close(): void;
	onClose(listener: () => void): void;
	/** Deliver every envelope that arrives while nothing is awaiting `next()`. */
	onEnvelope(listener: (envelope: Envelope) => void): void;
}

/**
 * Open a newline-delimited JSON connection to the bridge.
 *
 * Rejects if the socket errors before it connects; after that the connection
 * fails closed rather than throwing into a `net` callback.
 */
export function openConnection(socketPath: string): Promise<Connection> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		const queued: Envelope[] = [];
		const waiting: Array<(value: Envelope) => void> = [];
		const closeListeners: Array<() => void> = [];
		let envelopeListener: ((envelope: Envelope) => void) | null = null;
		let buffer = "";
		let closed = false;
		let queuedBytes = 0;

		const markClosed = () => {
			if (closed) return;
			closed = true;
			for (const listener of closeListeners.splice(0)) listener();
		};

		/**
		 * Report the reason, flush it, then drop the connection.
		 *
		 * Nothing here may throw: see rule 6 in the module header.
		 */
		const failClosed = (code: string, message: string) => {
			buffer = "";
			try {
				// `end` flushes the frame before FIN; `destroy` alone can discard it.
				socket.end(
					`${JSON.stringify({
						kind: "error",
						protocol: PROTOCOL.bridge,
						code,
						message,
						fatal: true,
					})}\n`,
				);
			} catch {
				// The peer may already be gone; closing is still the right outcome.
			}
			socket.destroy();
			markClosed();
		};

		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			if (closed) return;
			buffer += chunk;

			// The bound is per line: bytes since the last newline. Measuring the
			// whole buffer would reject a batch of valid small lines that merely
			// arrived in one chunk (wire spec rule 2).
			const pending = buffer.slice(buffer.lastIndexOf("\n") + 1);
			if (Buffer.byteLength(pending, "utf8") > LIMITS.frameBytes) {
				failClosed("frame_too_large", `line exceeds ${LIMITS.frameBytes} bytes`);
				return;
			}

			let index = buffer.indexOf("\n");
			while (index !== -1) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (line.trim().length > 0) {
					let envelope: Envelope;
					try {
						envelope = assertEnvelope(JSON.parse(line));
					} catch (error) {
						failClosed(
							"internal",
							`unparseable or malformed envelope: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
						return;
					}
					const resolveNext = waiting.shift();
					if (resolveNext) {
						resolveNext(envelope);
					} else if (envelopeListener) {
						try {
							envelopeListener(envelope);
						} catch {
							// A listener fault must not take the observed Pi process
							// down; the bridge resends after the next snapshot.
						}
					} else {
						// Nothing consumes inbound traffic before a listener is
						// attached, so the queue is bounded rather than unbounded.
						queuedBytes += Buffer.byteLength(line, "utf8");
						if (queuedBytes > LIMITS.totalBytes) {
							failClosed("buffer_overflow", `inbound queue exceeds ${LIMITS.totalBytes} bytes`);
							return;
						}
						queued.push(envelope);
					}
				}
				index = buffer.indexOf("\n");
			}
		});

		socket.on("close", markClosed);
		socket.on("error", (error: Error) => {
			markClosed();
			reject(error);
		});

		socket.on("connect", () => {
			resolve({
				send(envelope: Envelope) {
					assertEnvelope(envelope);
					socket.write(`${JSON.stringify(envelope)}\n`);
				},
				next(): Promise<Envelope> {
					const queuedEnvelope = queued.shift();
					if (queuedEnvelope) {
						queuedBytes = 0;
						return Promise.resolve(queuedEnvelope);
					}
					if (closed) return Promise.reject(new Error("muxr: connection closed"));
					return new Promise((resolveNext, rejectNext) => {
						waiting.push(resolveNext);
						closeListeners.push(() =>
							rejectNext(new Error("muxr: connection closed while waiting")),
						);
					});
				},
				close() {
					socket.destroy();
					markClosed();
				},
				onClose(listener: () => void) {
					if (closed) listener();
					else closeListeners.push(listener);
				},
				onEnvelope(listener: (envelope: Envelope) => void) {
					envelopeListener = listener;
					queuedBytes = 0;
					for (const envelope of queued.splice(0)) {
						try {
							listener(envelope);
						} catch {
							// As above: a listener fault is not fatal to Pi.
						}
					}
				},
			});
		});
	});
}

export interface HandshakeOptions {
	capabilityFile: string;
	registrationId: string;
	piVersion?: string;
}

/**
 * Perform the mutually authenticated handshake and return `registered`.
 *
 * The capability is read at handshake time, so a re-registration picks up the
 * fresh value the bridge wrote rather than reusing a consumed one. The bridge
 * is authenticated before the extension proves anything to it.
 */
export async function handshake(
	connection: Pick<Connection, "send" | "next">,
	{ capabilityFile, registrationId, piVersion = PROTOCOL.piVersion }: HandshakeOptions,
): Promise<Envelope> {
	const capability = readCapability(capabilityFile);
	const helloNonce = randomBytes(32).toString("hex");

	connection.send({
		kind: "hello",
		protocol: PROTOCOL.bridge,
		role: "extension",
		registrationId,
		nonce: helloNonce,
		piVersion,
	});

	const challenge = await connection.next();
	if (challenge.kind === "error") {
		throw new Error(`muxr: bridge refused registration (${String(challenge.code)})`);
	}
	if (challenge.kind !== "challenge") {
		throw new Error(`muxr: expected challenge, received ${String(challenge.kind)}`);
	}
	if (challenge.registrationId !== registrationId) {
		throw new Error("muxr: challenge registration id does not match");
	}

	const transcript = {
		protocol: PROTOCOL.bridge,
		bridgeEpoch: challenge.bridgeEpoch as number,
		registrationId,
		helloNonce,
		challengeNonce: challenge.nonce as string,
	};

	if (!macEquals(computeMac(capability, { ...transcript, role: "bridge" }), challenge.mac)) {
		throw new Error("muxr: bridge MAC verification failed");
	}

	connection.send({
		kind: "response",
		protocol: PROTOCOL.bridge,
		bridgeEpoch: transcript.bridgeEpoch,
		registrationId,
		mac: computeMac(capability, { ...transcript, role: "extension" }),
	});

	const registered = await connection.next();
	if (registered.kind !== "registered") {
		throw new Error(`muxr: expected registered, received ${String(registered.kind)}`);
	}
	return registered;
}
