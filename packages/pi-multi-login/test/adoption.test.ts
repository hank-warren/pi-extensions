/**
 * First-load credential adoption, driven through the extension itself.
 *
 * This is the one thing the package does *before* any session exists and
 * without being asked: a credential written by an earlier owner of the provider
 * id becomes a configured alias, and the config file is written even when it is
 * empty, because writing it is what stops the adoption from running again. Both
 * halves are load-phase side effects, so only loading the extension pins them —
 * `provider.test.ts` covers `adoptAliasesFromCredentials` as a pure function.
 *
 * It runs against a real `ModelRuntime` reading a real `auth.json`; the hermetic
 * preload is what makes that safe, by giving this process its own agent dir.
 */

import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createMockPi } from "../../../test/support/mock-pi.js";
import { CONFIG_FILENAME } from "../config.ts";
import multiLogin from "../index.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? "";
const CONFIG_PATH = join(AGENT_DIR, CONFIG_FILENAME);
const ALIAS_ID = "openai-codex-work";

/** A credential slot for an alias nobody has configured yet. */
function writeAdoptableCredentials(): void {
	writeFileSync(
		join(AGENT_DIR, "auth.json"),
		JSON.stringify({
			[ALIAS_ID]: { type: "oauth", access: "a", refresh: "r", expires: 0, accountId: "acct-1" },
		}),
	);
}

function registeredProviderIds(mock: ReturnType<typeof createMockPi>): string[] {
	return mock.providerRegistrations.map((registration) => registration.name);
}

test("a first load adopts an orphaned credential, then never writes again", async () => {
	assert.ok(AGENT_DIR, "the hermetic preload set an agent dir");
	writeAdoptableCredentials();

	const first = createMockPi();
	await multiLogin(first.pi);

	assert.deepEqual(registeredProviderIds(first), [ALIAS_ID], "the alias provider is registered");
	assert.deepEqual(JSON.parse(await readFile(CONFIG_PATH, "utf8")), {
		aliases: [{ base: "openai-codex", suffix: "work" }],
	});
	// The base is the longest OAuth provider id the credential extends, which is
	// what keeps this off `openai`.
	const written = statSync(CONFIG_PATH).mtimeMs;

	const second = createMockPi();
	await multiLogin(second.pi);

	assert.deepEqual(registeredProviderIds(second), [ALIAS_ID], "the same alias is registered again");
	assert.equal(statSync(CONFIG_PATH).mtimeMs, written, "the second load rewrites nothing");
});
