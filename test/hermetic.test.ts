/**
 * The preload's own tests.
 *
 * The redirect is asserted in-process, through the pid the preload stamps into
 * `PI_EXT_HERMETIC_PID`. A forked test process inherits the runner's mutated
 * environment, so asserting on `HOME` alone would pass whether or not `--import`
 * reached this process; the pid matches only when the preload ran *here*.
 *
 * Everything else is asserted from child processes: the tripwire runs on `exit`
 * and its verdict *is* the exit code, and the environment the preload must clear
 * has to be dirty before the process starts. A fake "real" agent dir is pointed
 * at through `PI_EXT_HERMETIC_REAL_AGENT_DIR`, except in the one case that
 * covers the default derivation.
 *
 * It lives here rather than beside the preload in `test/support/` because the
 * runner's globs (see the `test:unit` script) pick up `test/*.test.ts`, not the
 * support directory.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const HERMETIC = new URL("support/hermetic.ts", import.meta.url).href;

/** The config env vars the preload must delete, in the preload's own order. */
const CLEARED_ENV = [
	"PI_AUTO_PERMISSIONS_CONFIG",
	"PI_MULTI_LOGIN_CONFIG",
	"PI_STASH_CONFIG",
	"HERDR_ENV",
	"PI_SUBAGENT_CHILD",
	"PI_LOOP_ACTIVE",
	"PI_LOOP_ID",
];

test("every test process runs with a redirected HOME and agent dir", () => {
	const home = process.env.HOME;
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	// The preload stamped this pid, so the redirect below belongs to this process
	// rather than to the runner whose environment it inherited.
	assert.equal(
		process.env.PI_EXT_HERMETIC_PID,
		String(process.pid),
		"the preload ran in this process",
	);
	assert.ok(home, "HOME is set");
	assert.ok(agentDir, "PI_CODING_AGENT_DIR is set");
	assert.notEqual(home, userInfo().homedir, "HOME is not the account's real home");
	assert.ok(home.startsWith(tmpdir()), `HOME is under the scratch root: ${home}`);
	assert.ok(agentDir.startsWith(tmpdir()), `agent dir is under the scratch root: ${agentDir}`);
	assert.ok(existsSync(home) && existsSync(agentDir), "both scratch dirs exist");
});

/**
 * Run a throwaway script under the preload against a fake "real" agent dir
 * holding one pre-existing `settings.json`, and return the run's verdict.
 *
 * `body` is ESM source appended to the script, with the fixture agent dir bound
 * to `AGENT_DIR`. `env` overrides the child's environment and may be a function
 * of the fixture's home directory (the parent of `.pi/`), which is what lets one
 * case exercise the *derived* agent dir rather than the injected one. An empty
 * value unsets the variable, so `CI` and `PI_EXT_TEST_STRICT` are absent unless
 * a case asks for them.
 */
function runUnderPreload(
	body: string,
	env: Record<string, string> | ((home: string) => Record<string, string>) = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "hermetic-probe-"));
	const agentDir = join(dir, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), "{}\n");
	const script = join(dir, "probe.mjs");
	writeFileSync(script, `const AGENT_DIR = ${JSON.stringify(agentDir)};\n${body}\n`);
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		CI: "",
		PI_EXT_TEST_STRICT: "",
		PI_EXT_HERMETIC_REAL_AGENT_DIR: agentDir,
		...(typeof env === "function" ? env(dir) : env),
	};
	for (const [name, value] of Object.entries(childEnv)) {
		if (value === "") delete childEnv[name];
	}
	const result = spawnSync(process.execPath, ["--import", "tsx", "--import", HERMETIC, script], {
		encoding: "utf8",
		env: childEnv,
	});
	rmSync(dir, { recursive: true, force: true });
	return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

test("the config env vars extensions read are cleared", () => {
	// Set them in the child rather than reading this process's environment: the
	// runner already deleted them here, so an in-process assertion would pass on
	// any host whose shell does not export them — which is every CI runner.
	const dirty = Object.fromEntries(CLEARED_ENV.map((name) => [name, "x"]));
	const result = runUnderPreload(
		`
const NAMES = ${JSON.stringify(CLEARED_ENV)};
console.log(JSON.stringify(NAMES.map((name) => process.env[name] ?? null)));
`,
		dirty,
	);

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(
		JSON.parse(result.stdout.trim()),
		CLEARED_ENV.map(() => null),
		`every one of ${CLEARED_ENV.join(", ")} is cleared`,
	);
});

const WRITE_PROBE = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(AGENT_DIR, "probe.json"), "{}\\n");
`;

test("a run that leaves the real agent dir alone says nothing", () => {
	const result = runUnderPreload("", { PI_EXT_TEST_STRICT: "1" });
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /\[hermetic]/);
});

test("a new entry in the real agent dir warns locally and fails under strict", () => {
	const lenient = runUnderPreload(WRITE_PROBE);
	assert.equal(lenient.status, 0, lenient.stderr);
	assert.match(lenient.stderr, /\[hermetic] real agent dir changed during tests: \+probe\.json/);

	const strict = runUnderPreload(WRITE_PROBE, { PI_EXT_TEST_STRICT: "1" });
	assert.equal(strict.status, 1);
	assert.match(strict.stderr, /\[hermetic] real agent dir changed during tests: \+probe\.json/);
});

test("the watched dir is derived from the real HOME, captured before the redirect", () => {
	// No PI_EXT_HERMETIC_REAL_AGENT_DIR: the preload must derive `$HOME/.pi/agent`
	// *and* must read HOME before it overwrites it. Move the realHome/snapshot
	// capture below the redirect and this is the only case that fails — every other
	// one injects the path and would stay green while the tripwire silently watched
	// the scratch dir instead of the host's.
	const result = runUnderPreload(WRITE_PROBE, (home) => ({
		HOME: home,
		PI_EXT_HERMETIC_REAL_AGENT_DIR: "",
		PI_EXT_TEST_STRICT: "1",
	}));
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /\[hermetic] real agent dir changed during tests: \+probe\.json/);
});

test("a rewritten existing entry is reported too", () => {
	const result = runUnderPreload(
		`
import { utimesSync } from "node:fs";
import { join } from "node:path";
const later = new Date(Date.now() + 60_000);
utimesSync(join(AGENT_DIR, "settings.json"), later, later);
`,
		{ PI_EXT_TEST_STRICT: "1" },
	);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /real agent dir changed during tests: ~settings\.json/);
});

test("live-session churn is ignored even under strict", () => {
	const result = runUnderPreload(
		`
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
mkdirSync(join(AGENT_DIR, "sessions"), { recursive: true });
for (const name of ["statusline-usage.json", "auth.json", "models-store.json"]) {
  writeFileSync(join(AGENT_DIR, name), "{}\\n");
}
`,
		{ PI_EXT_TEST_STRICT: "1" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /\[hermetic]/);
});

test("on CI the mere existence of the real pi dir fails the run", () => {
	const result = runUnderPreload("", { CI: "1" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /\[hermetic] tests created or touched the real pi dir/);
});

test("on CI a run with no pi dir at all passes", () => {
	const dir = mkdtempSync(join(tmpdir(), "hermetic-probe-"));
	const script = join(dir, "probe.mjs");
	writeFileSync(script, "\n");
	const result = spawnSync(process.execPath, ["--import", "tsx", "--import", HERMETIC, script], {
		encoding: "utf8",
		env: {
			...process.env,
			CI: "1",
			PI_EXT_TEST_STRICT: "",
			PI_EXT_HERMETIC_REAL_AGENT_DIR: join(dir, "absent", ".pi", "agent"),
		},
	});
	rmSync(dir, { recursive: true, force: true });
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /\[hermetic]/);
});

test("the scratch root is removed when the process exits", () => {
	const result = runUnderPreload(`
console.log(process.env.HOME);
`);
	assert.equal(result.status, 0, result.stderr);
	const scratchHome = result.stdout.trim();
	assert.ok(scratchHome.length > 0, "the child printed its scratch HOME");
	assert.equal(existsSync(scratchHome), false, `scratch root survived: ${scratchHome}`);
});
