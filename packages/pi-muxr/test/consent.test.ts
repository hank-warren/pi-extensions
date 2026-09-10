/**
 * Consent-gate tests.
 *
 * Chat write is the one path in this package that can change a session, so
 * these tests assert the gates from the *off* direction: every one of them
 * must be independently sufficient to keep it off. A regression that opens
 * this by default is the worst failure this package could have.
 *
 * `test/support/hermetic.ts` gives every test process a private HOME and
 * PI_CODING_AGENT_DIR, so `getAgentDir()` resolves into a scratch directory
 * and writing a settings file here cannot touch the host's real one.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
	CHAT_WRITE_CAPABILITY,
	CHAT_WRITE_FLAG,
	CHAT_WRITE_SETTING,
	consentRefusalReason,
	evaluateChatWriteConsent,
	readChatWriteSetting,
} from "../src/consent.ts";

/** Write the scratch global settings file `getAgentDir()` resolves to. */
function writeGlobalSettings(body: unknown): void {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	assert.ok(agentDir, "hermetic preload must provide a scratch PI_CODING_AGENT_DIR");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(body));
}

/** Write a project settings file under a scratch cwd. */
function writeProjectSettings(cwd: string, body: unknown): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(body));
}

function scratchCwd(name: string): string {
	const dir = join(process.env.PI_CODING_AGENT_DIR as string, "cwd", name);
	mkdirSync(dir, { recursive: true });
	test.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("the setting is off when no settings file exists at all", () => {
	assert.equal(readChatWriteSetting({ cwd: scratchCwd("none"), projectTrusted: false }), false);
});

test("only a literal true enables the setting", () => {
	const cwd = scratchCwd("literal");
	for (const value of [true]) {
		writeGlobalSettings({ [CHAT_WRITE_SETTING]: value });
		assert.equal(readChatWriteSetting({ cwd, projectTrusted: false }), true);
	}
	// A truthy string or number is a misconfiguration, not consent.
	for (const value of ["true", 1, "yes", {}, [], null]) {
		writeGlobalSettings({ [CHAT_WRITE_SETTING]: value });
		assert.equal(readChatWriteSetting({ cwd, projectTrusted: false }), false, String(value));
	}
});

test("an unreadable or malformed settings file leaves the gate off, and never throws", () => {
	const cwd = scratchCwd("malformed");
	const agentDir = process.env.PI_CODING_AGENT_DIR as string;
	mkdirSync(agentDir, { recursive: true });
	for (const body of ["{not json", "[]", '"a string"', "null", ""]) {
		writeFileSync(join(agentDir, "settings.json"), body);
		assert.equal(readChatWriteSetting({ cwd, projectTrusted: false }), false, body);
	}
});

test("an untrusted project cannot turn on chat write by shipping settings", () => {
	const cwd = scratchCwd("untrusted");
	writeGlobalSettings({});
	writeProjectSettings(cwd, { [CHAT_WRITE_SETTING]: true });
	// This is the whole point of the trust check: a repository someone else
	// wrote must not be able to grant a write capability by being opened.
	assert.equal(readChatWriteSetting({ cwd, projectTrusted: false }), false);
	assert.equal(readChatWriteSetting({ cwd, projectTrusted: true }), true);
});

test("a trusted project can turn the setting off again", () => {
	const cwd = scratchCwd("override-off");
	writeGlobalSettings({ [CHAT_WRITE_SETTING]: true });
	writeProjectSettings(cwd, { [CHAT_WRITE_SETTING]: false });
	assert.equal(readChatWriteSetting({ cwd, projectTrusted: true }), false);
	// With the project untrusted the global value still applies.
	assert.equal(readChatWriteSetting({ cwd, projectTrusted: false }), true);
});

test("all three gates are required, and each alone keeps chat write off", () => {
	const cwd = scratchCwd("gates");
	writeGlobalSettings({ [CHAT_WRITE_SETTING]: true });
	const base = { cwd, projectTrusted: false, flagPresent: true, bridgeRequested: true };

	assert.deepEqual(evaluateChatWriteConsent(base), { enabled: true, missing: [] });
	assert.deepEqual(evaluateChatWriteConsent({ ...base, flagPresent: false }), {
		enabled: false,
		missing: ["flag"],
	});
	assert.deepEqual(evaluateChatWriteConsent({ ...base, bridgeRequested: false }), {
		enabled: false,
		missing: ["capability"],
	});

	writeGlobalSettings({});
	assert.deepEqual(evaluateChatWriteConsent(base), { enabled: false, missing: ["setting"] });
	// Every failing gate is reported at once, so an operator does not fix one
	// only to discover the next.
	assert.deepEqual(
		evaluateChatWriteConsent({ ...base, flagPresent: false, bridgeRequested: false }),
		{ enabled: false, missing: ["setting", "flag", "capability"] },
	);
});

test("the refusal reason names the gates, as a stable machine token", () => {
	assert.equal(consentRefusalReason(["setting"]), "chat_write_disabled:setting");
	assert.equal(
		consentRefusalReason(["setting", "flag", "capability"]),
		"chat_write_disabled:setting,flag,capability",
	);
});

test("the gate names are the ones documented for operators", () => {
	// These strings appear in the README and in the bridge; renaming one
	// without the other silently breaks an operator's configuration.
	assert.equal(CHAT_WRITE_SETTING, "muxr.experimentalChatWrite");
	assert.equal(CHAT_WRITE_FLAG, "muxr-experimental-chat-write");
	assert.equal(CHAT_WRITE_CAPABILITY, "chatWrite");
});
