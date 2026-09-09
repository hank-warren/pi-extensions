/**
 * Cross-repo contract parity guard.
 *
 * This package hand-copies the muxr wire contract, and nothing mechanical used
 * to check the two agreed — the drift that review found (four missing `LIMITS`
 * keys, a missing `CURSORS`, a `terminal_lease` event accepted with no payload
 * shape to validate it against) was invisible to every existing test, because
 * `wire.test.ts` only checks this package against *itself*.
 *
 * The guard is offline and deterministic by construction: it compares against a
 * vendored artifact pinned by sha256, never a live clone. Refresh it with
 * `node scripts/refresh-muxr-contracts.mjs <muxr-clone> <ref>`, and bump the
 * artifact, the ref and the digest in one reviewable commit.
 *
 * Two scopes, per the parity review:
 *
 * - **wire** — must be byte-identical. A disagreement here is a live handshake
 *   failure between the bridge and this extension.
 * - **host** — proof/bridge-side names. Matched where this package carries them,
 *   waived key by key with a stated reason where it does not.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	HOST_EXPORTS,
	WIRE_EXPORTS,
	WIRE_LIMIT_KEYS,
	buildWire,
	canonicalize,
} from "./support/canonical.ts";
import * as contracts from "../src/contracts.ts";

const ARTIFACT_URL = new URL("../vendor/muxr-contracts.canonical.json", import.meta.url);
const LOCK_URL = new URL("../vendor/muxr-contracts.lock.json", import.meta.url);

const artifactBytes = readFileSync(ARTIFACT_URL);
const lock = JSON.parse(readFileSync(LOCK_URL, "utf8")) as {
	repo: string;
	ref: string;
	refState: string;
	path: string;
	sha256: string;
};
const vendored = JSON.parse(artifactBytes.toString("utf8")) as {
	wire: Record<string, unknown>;
	host: Record<string, unknown>;
};

/**
 * Host-scope names this package deliberately does not carry.
 *
 * Listed individually with a reason, so adding one is a visible decision rather
 * than a silently widened exemption.
 */
const HOST_WAIVERS: Readonly<Record<string, string>> = Object.freeze({
	LAUNCH_RECORD_HERDR_SHAPE:
		"the launch record is built and verified by the bridge; the extension never reads one",
	LAUNCH_RECORD_SHAPE:
		"the launch record is built and verified by the bridge; the extension never reads one",
});

test("the vendored artifact is unmodified", () => {
	// If this fails, someone edited the vendored copy by hand instead of
	// refreshing it from muxr, which would make every assertion below a
	// statement about a file we invented.
	assert.equal(createHash("sha256").update(artifactBytes).digest("hex"), lock.sha256);
	assert.equal(lock.repo, "hank-warren/muxr");
	assert.match(lock.ref, /^[0-9a-f]{40}$/);
});

test("the vendored artifact was taken from a commit, not a working tree", () => {
	// A working-tree read is legitimate while the muxr side is in flight, but it
	// cannot be released: the lock would name a commit that does not contain the
	// bytes. Failing here is the reminder to re-pin before merge.
	assert.equal(
		lock.refState,
		"commit",
		`vendored artifact came from a ${lock.refState}; re-run refresh-muxr-contracts.mjs with a ref`,
	);
});

test("the wire scope is byte-identical to muxr", () => {
	const mine = buildWire(contracts as unknown as Record<string, unknown>);
	// Compared as canonical strings so a key-order difference is not reported
	// as a mismatch, and so the failure message is diffable.
	assert.equal(canonicalize(mine), canonicalize(vendored.wire));
});

test("every wire export is compared, and none is missing from this package", () => {
	// buildWire throws on a missing export, so this both documents the set
	// and proves the guard covers all of it rather than a hand-picked subset.
	for (const name of WIRE_EXPORTS) {
		assert.ok(Object.hasOwn(contracts, name), `missing wire export ${name}`);
		assert.ok(Object.hasOwn(vendored.wire, name), `vendored artifact lacks ${name}`);
	}
	for (const key of WIRE_LIMIT_KEYS) {
		assert.ok(
			Object.hasOwn(contracts.LIMITS, key),
			`LIMITS is missing the wire-relevant key ${key}`,
		);
	}
	// The artifact carries LIMITS as its own projected key.
	assert.ok(Object.hasOwn(vendored.wire, "LIMITS"));
});

test("each wire export matches individually, so a failure names the culprit", () => {
	const mine = buildWire(contracts as unknown as Record<string, unknown>) as Record<
		string,
		unknown
	>;
	for (const name of Object.keys(vendored.wire)) {
		assert.equal(
			canonicalize(mine[name]),
			canonicalize(vendored.wire[name]),
			`wire export ${name} differs from muxr@${lock.ref.slice(0, 12)}`,
		);
	}
});

test("the host scope is matched or waived, key by key", () => {
	for (const name of HOST_EXPORTS) {
		assert.ok(Object.hasOwn(vendored.host, name), `vendored artifact lacks host export ${name}`);
		const waiver = HOST_WAIVERS[name];
		if (waiver) {
			// A waiver means this package must genuinely not carry it; carrying it
			// while claiming a waiver is the drift the waiver was meant to admit.
			assert.equal(
				Object.hasOwn(contracts, name),
				false,
				`${name} is waived ("${waiver}") but this package now exports it — drop the waiver`,
			);
			continue;
		}
		assert.ok(Object.hasOwn(contracts, name), `host export ${name} is neither carried nor waived`);
		assert.equal(
			canonicalize((contracts as unknown as Record<string, unknown>)[name]),
			canonicalize(vendored.host[name]),
			`host export ${name} differs from muxr@${lock.ref.slice(0, 12)}`,
		);
	}
});

test("the waiver list is exactly what is documented, so widening it is visible", () => {
	assert.deepEqual(Object.keys(HOST_WAIVERS).sort(), [
		"LAUNCH_RECORD_HERDR_SHAPE",
		"LAUNCH_RECORD_SHAPE",
	]);
});

test("the full LIMITS object matches muxr, beyond the wire subset", () => {
	// The wire digest only covers four keys, so the four the review found
	// missing (ledgerRecords, ledgerBytes, leaseHeartbeatMs, leaseExpiryMs)
	// would still be droppable without this. The header claims a faithful port;
	// this is what makes that claim testable.
	assert.deepEqual(contracts.LIMITS, {
		events: 2048,
		totalBytes: 4 * 1024 * 1024,
		frameBytes: 1024 * 1024,
		ledgerRecords: 100000,
		ledgerBytes: 64 * 1024 * 1024,
		capabilityTtlMs: 60000,
		leaseHeartbeatMs: 5000,
		leaseExpiryMs: 15000,
	});
});

test("canonicalize sorts object keys but never reorders arrays", () => {
	// Array order is semantic here: MESSAGE_KINDS and EVENT_TYPES order is
	// asserted by the proof's own tests, so sorting them would hide a real
	// difference behind a green digest.
	assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
	assert.notEqual(canonicalize(["a", "b"]), canonicalize(["b", "a"]));
	assert.equal(canonicalize({ x: [{ b: 1, a: 2 }] }), '{"x":[{"a":2,"b":1}]}');
});
