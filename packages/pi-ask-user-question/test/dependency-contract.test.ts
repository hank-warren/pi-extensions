/**
 * Guards the cross-package dependency contract.
 *
 * view/dialog.ts deep-imports
 * `@hank-warren/pi-permission-selector/selector.ts`. Inside this workspace that
 * resolves through npm's hoisted symlink, so a broken contract is invisible to
 * both `tsc` and the unit tests. It only fails for an EXTERNAL consumer
 * installing the packed tarball — which is the worst place to find out.
 *
 * AGENTS.md §Structure: the sibling must be in plain `dependencies` and must
 * NEVER be in `bundledDependencies` (bundling was tested and is actively wrong
 * here — workspaces hoist the sibling to a root symlink, so there is nothing
 * inside the package to bundle and the tarball ships without it).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SIBLING = "@hank-warren/pi-permission-selector";

const read = (path: string) =>
	JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));

const pkg = read("../package.json") as {
	dependencies?: Record<string, string>;
	bundledDependencies?: string[];
	peerDependencies?: Record<string, string>;
};

test("the sibling is a plain dependency", () => {
	assert.ok(pkg.dependencies?.[SIBLING], `${SIBLING} must be in dependencies`);
});

test("the sibling is never bundled", () => {
	assert.ok(
		!pkg.bundledDependencies?.includes(SIBLING),
		"bundledDependencies breaks this package - see AGENTS.md §Structure",
	);
});

test("the deep import target resolves and exports OptionSelector", async () => {
	const mod = await import(`${SIBLING}/selector.ts`);
	assert.equal(typeof mod.OptionSelector, "function");
});

test("the resolved sibling supports the multi-select mode the dialog relies on", async () => {
	const { OptionSelector } = (await import(`${SIBLING}/selector.ts`)) as typeof import(
		"@hank-warren/pi-permission-selector/selector.ts"
	);
	const submitted: string[][] = [];
	const selector = new OptionSelector({
		options: [
			{ value: "a", label: "A" },
			{ value: "b", label: "B" },
		],
		multiSelect: true,
		onSubmit: (options) => submitted.push(options.map((o) => o.value)),
	});
	selector.handleInput("2");
	selector.handleInput("\r");
	assert.deepEqual(submitted, [["b"]], "a sibling older than 1.1.0 would commit on the digit instead");
});

test("the declared range is satisfied by a sibling that actually ships selector.ts", () => {
	const sibling = read("../../pi-permission-selector/package.json") as {
		version: string;
		files: string[];
	};
	// The published 0.1.1 predates selector.ts. If this ever fails, the range in
	// package.json points at a sibling version whose tarball lacks the deep
	// import target, and external installs will throw MODULE_NOT_FOUND.
	assert.ok(
		sibling.files.includes("selector.ts") && sibling.files.includes("keys.ts"),
		"the sibling version this package builds against must publish selector.ts and keys.ts",
	);
});
