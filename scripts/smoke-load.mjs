#!/usr/bin/env node
/**
 * Extension load + registration smoke test.
 *
 * The rest of `npm test` proves syntax (bash -n / ast.parse / tsc) and inventory
 * (validate.py), but nothing proves an extension entrypoint actually *loads* under
 * a real Pi runtime and registers the surface it is supposed to register. This
 * script closes that gap: it drives Pi's own `discoverAndLoadExtensions` -- the
 * same loader the agent uses at startup -- over every entrypoint in the root
 * `pi.extensions` manifest, then compares the registered tools, commands,
 * handlers, flags, and shortcuts against an exact expected set.
 *
 * Exact-set comparison means both a missing registration and an unexpected extra
 * registration fail. When you intentionally add or remove a tool/command/handler,
 * update EXPECTED_SURFACES below in the same commit.
 *
 * Isolation: `agentDir` is pointed at a throwaway temp directory so the host's
 * real ~/.pi (settings.json, installed packages) can never influence or be
 * mutated by this run.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Exact expected registration surface per entrypoint. Every key in
 * `pi.extensions` must appear here, and every category is compared as an exact
 * set: missing entries and extra entries both fail.
 *
 * Categories omitted from an entry are treated as empty.
 */
const EXPECTED_SURFACES = {
	"./packages/pi-statusline/index.ts": {
		commands: ["statusline"],
		handlers: [
			"model_select",
			"session_shutdown",
			"session_start",
			"session_tree",
			"tool_call",
			"turn_end",
		],
	},
	"./packages/pi-stats/index.ts": {
		commands: ["stats"],
	},
	"./packages/pi-auto-permissions/index.ts": {
		tools: ["request_override"],
		commands: ["auto-permissions"],
		handlers: ["session_shutdown", "session_start", "tool_call", "tool_execution_end"],
	},
	"./packages/pi-plan-mode/index.ts": {
		tools: ["plan_mode_complete", "plan_mode_question"],
		commands: ["plan"],
		flags: ["plan"],
		// No agent_end hook: the legacy <proposed_plan> completion path is gone.
		// No context hook: the plan lives in a file, so nothing is reinjected.
		// No thinking_level_select hook: Plan mode never changes the thinking
		// level, so it has no manual override to detect.
		handlers: [
			"agent_settled",
			"before_agent_start",
			"session_shutdown",
			"session_start",
			"tool_call",
		],
	},
	// ask_user_question registers unconditionally; reconcile.ts strips it from
	// the ACTIVE tool set at before_agent_start when ctx.hasUI is false. The
	// smoke run inspects the registration surface, not the active set, so the
	// tool is expected here even though this headless run would never expose it
	// to a model.
	"./packages/pi-ask-user-question/index.ts": {
		tools: ["ask_user_question"],
		handlers: ["before_agent_start"],
	},
	"./packages/pi-multi-login/index.ts": {
		commands: ["multi-login"],
		handlers: ["session_start"],
	},
	// Timers are armed only in session_start or the command handler, never at
	// load. The input handler arms the one-turn inline-invocation hint that
	// before_agent_start appends; loop_start is the model-invoked start it
	// points at, refused on any turn the hint did not arm.
	"./packages/pi-loop/index.ts": {
		// No loop_start: a loop is started by the user approving a card, never by
		// a tool. No `input` handler either — it existed only to arm the inline
		// invocation that tool served.
		tools: ["loop_complete", "loop_progress", "loop_propose", "loop_wait"],
		commands: ["loop"],
		handlers: [
			"agent_end",
			"agent_start",
			"agent_settled",
			"before_agent_start",
			"session_shutdown",
			"session_start",
		],
	},
	// One shortcut and nothing else: no tool, no command, no session hook. The
	// stash list lives in the extension instance, so there is nothing to persist
	// or restore and no lifecycle to observe.
	//
	// The key is configurable, so this pins the default. The agentDir isolation
	// below is what makes that deterministic: a developer's own pi-stash.json
	// would otherwise change the registered key and fail this check.
	"./packages/pi-stash/index.ts": {
		shortcuts: ["alt+s"],
	},
};

const CATEGORIES = ["tools", "commands", "handlers", "flags", "shortcuts"];

function formatSet(values) {
	return values.length > 0 ? values.join(", ") : "(none)";
}

function diffCategory(actual, expected) {
	const actualSet = new Set(actual);
	const expectedSet = new Set(expected);
	return {
		missing: expected.filter((name) => !actualSet.has(name)),
		extra: actual.filter((name) => !expectedSet.has(name)),
	};
}

async function main() {
	const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
	const entrypoints = manifest.pi?.extensions ?? [];
	if (entrypoints.length === 0) {
		console.error("Extension load smoke: package.json pi.extensions is empty");
		return 1;
	}

	const errors = [];

	// Keep the expected-surface table honest: it must describe exactly the
	// manifest, so a newly registered extension cannot slip through unasserted.
	for (const entrypoint of entrypoints) {
		if (!Object.hasOwn(EXPECTED_SURFACES, entrypoint)) {
			errors.push(
				`${entrypoint}: entrypoint is in pi.extensions but has no EXPECTED_SURFACES entry in scripts/smoke-load.mjs`,
			);
		}
	}
	for (const entrypoint of Object.keys(EXPECTED_SURFACES)) {
		if (!entrypoints.includes(entrypoint)) {
			errors.push(
				`${entrypoint}: EXPECTED_SURFACES entry has no matching pi.extensions entrypoint`,
			);
		}
	}
	if (errors.length > 0) {
		console.error("Extension load smoke failed:");
		for (const error of errors) console.error(`- ${error}`);
		return 1;
	}

	const { discoverAndLoadExtensions } = await import("@earendil-works/pi-coding-agent");

	// Throwaway agent dir: never touch or read the host's real ~/.pi. The env var
	// matters as much as the argument -- extensions resolve their own config with
	// `getAgentDir()`, which reads PI_CODING_AGENT_DIR and ignores this call's
	// agentDir parameter entirely.
	const agentDir = mkdtempSync(join(tmpdir(), "pi-smoke-load-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let result;
	try {
		result = await discoverAndLoadExtensions(entrypoints, REPO_ROOT, agentDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}

	for (const { path, error } of result.errors ?? []) {
		errors.push(`${path}: failed to load: ${error}`);
	}

	const byEntrypoint = new Map();
	for (const extension of result.extensions) {
		const relative = `./${resolve(extension.path).slice(REPO_ROOT.length + 1)}`;
		byEntrypoint.set(relative, extension);
	}

	// A discovered extension outside the manifest means agentDir isolation leaked
	// host state into the run; the comparison below would be meaningless.
	for (const relative of byEntrypoint.keys()) {
		if (!entrypoints.includes(relative)) {
			errors.push(`${relative}: unexpected extension loaded (host state leaked into the smoke run)`);
		}
	}

	for (const entrypoint of entrypoints) {
		const extension = byEntrypoint.get(entrypoint);
		if (!extension) {
			errors.push(`${entrypoint}: entrypoint did not load`);
			continue;
		}
		const expected = EXPECTED_SURFACES[entrypoint];
		for (const category of CATEGORIES) {
			const actual = [...(extension[category]?.keys() ?? [])].map(String).sort();
			const want = [...(expected[category] ?? [])].sort();
			const { missing, extra } = diffCategory(actual, want);
			if (missing.length > 0 || extra.length > 0) {
				errors.push(
					`${entrypoint}: ${category} mismatch (expected: ${formatSet(want)}; actual: ${formatSet(actual)})`,
				);
			}
		}
	}

	if (errors.length > 0) {
		console.error("Extension load smoke failed:");
		for (const error of errors) console.error(`- ${error}`);
		console.error(
			"\nIf a registration change was intentional, update EXPECTED_SURFACES in scripts/smoke-load.mjs.",
		);
		return 1;
	}

	console.log(`Extension load smoke: ok (${entrypoints.length} entrypoints, exact surface match)`);
	return 0;
}

process.exitCode = await main();
