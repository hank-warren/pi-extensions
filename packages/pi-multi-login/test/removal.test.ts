/**
 * Alias removal is transactional at the only layer that survives a restart.
 *
 * The failure that motivated this: the credential was deleted first, so a
 * later config-write failure left an alias the user could still select but
 * could never authenticate — and it came back on every restart.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AliasEntry } from "../config.ts";
import { removeAliasEntry, type AliasRemovalSteps } from "../removal.ts";

const ALIASES: AliasEntry[] = [
	{ base: "anthropic", suffix: "work" },
	{ base: "anthropic", suffix: "personal" },
];

function steps(overrides: Partial<AliasRemovalSteps> = {}) {
	const calls: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const saved: AliasEntry[][] = [];
	const base: AliasRemovalSteps = {
		saveConfig(remaining) {
			calls.push("saveConfig");
			saved.push(remaining);
		},
		unregisterRuntimeProvider() {
			calls.push("unregisterRuntimeProvider");
		},
		unregisterSessionProvider() {
			calls.push("unregisterSessionProvider");
		},
		async logout() {
			calls.push("logout");
		},
		notify(message, level) {
			notifications.push({ message, level });
		},
	};
	return { steps: { ...base, ...overrides }, calls, notifications, saved };
}

test("config is committed before any live or destructive step", async () => {
	const h = steps();
	const result = await removeAliasEntry("anthropic-work", ALIASES, "/tmp/config.json", h.steps);

	assert.deepEqual(h.calls, [
		"saveConfig",
		"unregisterRuntimeProvider",
		"unregisterSessionProvider",
		"logout",
	]);
	assert.equal(result.outcome, "removed");
	assert.equal(result.restartRequired, false);
	assert.deepEqual(result.aliases, [{ base: "anthropic", suffix: "personal" }]);
	assert.deepEqual(h.saved, [[{ base: "anthropic", suffix: "personal" }]]);
	assert.equal(h.notifications.at(-1)?.level, "info");
});

test("a failed config write leaves aliases, providers and the credential untouched", async () => {
	const h = steps({
		saveConfig() {
			throw new Error("read-only filesystem");
		},
	});
	const result = await removeAliasEntry("anthropic-work", ALIASES, "/tmp/config.json", h.steps);

	assert.equal(result.outcome, "config-failed");
	assert.deepEqual(result.aliases, ALIASES, "the alias survives a failed commit");
	assert.deepEqual(h.calls, [], "nothing live is touched after the write fails");
	assert.match(h.notifications.at(-1)?.message ?? "", /read-only filesystem/);
	assert.equal(h.notifications.at(-1)?.level, "error");
});

test("a live unregister failure keeps the commit and asks for a restart", async () => {
	const h = steps({
		unregisterRuntimeProvider() {
			throw new Error("runtime is gone");
		},
	});
	const result = await removeAliasEntry("anthropic-work", ALIASES, "/tmp/config.json", h.steps);

	assert.equal(result.outcome, "removed");
	assert.equal(result.restartRequired, true);
	assert.deepEqual(result.aliases, [{ base: "anthropic", suffix: "personal" }]);
	assert.ok(h.calls.includes("logout"), "removal still completes through the credential");
	assert.match(h.notifications[0]?.message ?? "", /Restart Pi to finish removal/);
	assert.equal(h.notifications.at(-1)?.level, "warning");
});

test("a logout failure orphans only the credential and says how to clean it up", async () => {
	const h = steps({
		async logout() {
			throw new Error("keychain locked");
		},
	});
	const result = await removeAliasEntry("anthropic-work", ALIASES, "/tmp/config.json", h.steps);

	assert.equal(result.outcome, "removed-credential-orphaned");
	assert.deepEqual(result.aliases, [{ base: "anthropic", suffix: "personal" }]);
	assert.match(h.notifications.at(-1)?.message ?? "", /could not delete its credential/);
	assert.match(h.notifications.at(-1)?.message ?? "", /\/logout/);
});

test("removing an alias that is already gone is an idempotent no-op", async () => {
	const h = steps();
	const first = await removeAliasEntry("anthropic-work", ALIASES, "/tmp/config.json", h.steps);
	const second = await removeAliasEntry(
		"anthropic-work",
		first.aliases,
		"/tmp/config.json",
		h.steps,
	);

	assert.equal(second.outcome, "not-configured");
	assert.deepEqual(second.aliases, first.aliases);
	assert.deepEqual(
		h.calls.filter((call) => call === "saveConfig"),
		["saveConfig"],
		"the second removal writes nothing",
	);
	assert.match(h.notifications.at(-1)?.message ?? "", /already removed/);
});
