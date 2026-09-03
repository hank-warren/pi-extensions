/**
 * Test preload: every test process gets a private HOME and agent dir, and the
 * host's real `~/.pi/agent` is watched for writes.
 *
 * Node propagates `--import` to the processes it forks per test file, so one
 * `--import ./test/support/hermetic.ts` on the runner covers the whole suite.
 * That is the point: extensions here resolve their own config through
 * `getAgentDir()` and `homedir()`, so a test that forgets to pass a scratch
 * path does not fail — it silently reads, and sometimes writes, the machine
 * running the tests. Two of those escapes shipped from this repo before this
 * file existed (a real `~/.pi/agent/loop` ledger per composition run, and
 * pi-multi-login's first-load credential adoption).
 *
 * A test that saves and restores `process.env.HOME` by hand is working around
 * a guarantee it already has.
 *
 * Two limits of the local tripwire, both deliberate. It compares *top-level*
 * entry names and mtimes, so modifying an existing file in place under an
 * existing subdirectory (say `loop/<id>/criteria.json`) bumps no top-level mtime
 * and goes unreported locally; the CI branch below has no such gap, because it
 * refuses a `~/.pi` that exists at all. And `statusline-usage.json` is on the
 * churn list, so a regression of pi-statusline's agent-dir resolution writes to
 * the host's real cache without tripping a local run — that one is caught by CI
 * and by the canary's mtime check on the real `statusline-*.json` files.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Entries the host legitimately rewrites while the suite runs, because a live
 * Pi session in another terminal owns them: the session transcripts, the
 * statusline's shared usage cache, and the credential/model stores its polls
 * refresh. Anything outside this list changing means a test escaped.
 */
const LIVE_SESSION_CHURN = new Set([
	"sessions",
	"statusline-usage.json",
	"auth.json",
	"models-store.json",
]);

/**
 * Config env vars the extensions in this repo read. A host that has any of them
 * set would otherwise point its own config at a test process.
 */
const CLEARED_ENV = [
	"PI_AUTO_PERMISSIONS_CONFIG",
	"PI_MULTI_LOGIN_CONFIG",
	"PI_STASH_CONFIG",
	"HERDR_ENV",
	"PI_SUBAGENT_CHILD",
	"PI_LOOP_ACTIVE",
	"PI_LOOP_ID",
];

const realHome = process.env.HOME ?? homedir();
/** Overridable so this preload's own test can point the tripwire at a fake. */
const realAgentDir = process.env.PI_EXT_HERMETIC_REAL_AGENT_DIR ?? join(realHome, ".pi", "agent");
const realPiDir = dirname(realAgentDir);

/** Top-level entry names mapped to their mtimes, or null when the dir is absent. */
function snapshot(dir: string): Map<string, number> | null {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return null;
	}
	const entries = new Map<string, number>();
	for (const name of names) {
		if (LIVE_SESSION_CHURN.has(name)) continue;
		try {
			entries.set(name, statSync(join(dir, name)).mtimeMs);
		} catch {
			// Raced with a live session removing it; treat it as absent.
		}
	}
	return entries;
}

function changedEntries(before: Map<string, number> | null, after: Map<string, number> | null): string[] {
	if (before === null && after === null) return [];
	const left = before ?? new Map<string, number>();
	const right = after ?? new Map<string, number>();
	const changed: string[] = [];
	for (const [name, mtime] of right) {
		if (!left.has(name)) changed.push(`+${name}`);
		else if (left.get(name) !== mtime) changed.push(`~${name}`);
	}
	for (const name of left.keys()) {
		if (!right.has(name)) changed.push(`-${name}`);
	}
	return changed.sort();
}

const before = snapshot(realAgentDir);

const scratchRoot = mkdtempSync(join(tmpdir(), "pi-ext-hermetic-"));
const scratchHome = join(scratchRoot, "home");
const scratchAgentDir = join(scratchRoot, "agent");
mkdirSync(scratchHome, { recursive: true });
mkdirSync(scratchAgentDir, { recursive: true });
process.env.HOME = scratchHome;
process.env.PI_CODING_AGENT_DIR = scratchAgentDir;
for (const name of CLEARED_ENV) delete process.env[name];
// Proof of which process did the redirecting. A forked test process inherits the
// runner's mutated environment, so `HOME` alone cannot tell "the preload ran
// here" from "the parent's env came along"; a pid can.
process.env.PI_EXT_HERMETIC_PID = String(process.pid);

process.on("exit", () => {
	rmSync(scratchRoot, { recursive: true, force: true });

	// A fresh CI runner has no ~/.pi at all, so its mere existence is proof that
	// something in the suite created it. No mtime comparison can be that strict
	// locally, where the developer's own agent dir is right there.
	if (process.env.CI) {
		let exists = true;
		try {
			statSync(realPiDir);
		} catch {
			exists = false;
		}
		if (exists) {
			console.error(`[hermetic] tests created or touched the real pi dir: ${realPiDir}`);
			process.exitCode = 1;
		}
		return;
	}

	const changed = changedEntries(before, snapshot(realAgentDir));
	if (changed.length === 0) return;
	console.error(`[hermetic] real agent dir changed during tests: ${changed.join(", ")}`);
	if (process.env.PI_EXT_TEST_STRICT) process.exitCode = 1;
});
