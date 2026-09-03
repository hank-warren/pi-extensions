/**
 * Contract test for the cross-package export surface.
 *
 * `keys.ts` and `selector.ts` are consumed by pi-auto-permissions and
 * pi-ask-user-question through the PUBLISHED npm package
 * (`@hank-warren/pi-permission-selector`). Renaming or removing an export, or
 * dropping a file from the `files` allowlist, breaks those consumers at runtime
 * from a packed tarball — a failure no typecheck in this workspace catches,
 * because in-workspace imports resolve through the hoisted symlink.
 *
 * This is now the only such contract in the repository: pi-herdr-auto-title had
 * an equivalent guard for its deep import of pi-auto-permissions'
 * `guardian-transport.ts`, which was deleted along with that dependency when the
 * helper was duplicated into both packages instead (see `DUPLICATED_SOURCES` in
 * scripts/validate.py).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as keys from "../keys.ts";
import * as selector from "../selector.ts";

const pkg = JSON.parse(
	readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { files: string[] };

test("keys.ts exports the frozen shared surface", () => {
	const required = [
		"COMMENT_CURSOR",
		"consumePasteChunk",
		"digitIndex",
		"handleCommentKey",
		"idleCommentState",
		"isBackspaceKey",
		"isCharKey",
		"isDownKey",
		"isEnterKey",
		"isEscapeKey",
		"isLeftKey",
		"isRightKey",
		"isShiftTabKey",
		"isSpaceKey",
		"isPreNumbered",
		"isPrintable",
		"isTabKey",
		"isUpKey",
		"numberLabel",
		"removeLastCharacter",
		"resolveDigit",
		"sanitizePaste",
	];
	for (const name of required) {
		assert.ok(name in keys, `keys.ts must export ${name} (cross-package contract)`);
	}
});

test("selector.ts exports OptionSelector", () => {
	assert.equal(typeof selector.OptionSelector, "function");
});

test("shared modules are in the published files allowlist", () => {
	for (const file of ["keys.ts", "selector.ts"]) {
		assert.ok(
			pkg.files.includes(file),
			`${file} must be in package.json "files" or consumers get MODULE_NOT_FOUND from the tarball`,
		);
	}
});

