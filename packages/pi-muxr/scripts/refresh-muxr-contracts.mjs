/**
 * Refresh the vendored muxr contract artifact. Manual, offline, never in CI.
 *
 *   node packages/pi-muxr/scripts/refresh-muxr-contracts.mjs <path-to-muxr-clone> [ref]
 *
 * Reads `packages/contracts` from a **local** muxr checkout, reduces it to the
 * canonical form, and rewrites `vendor/muxr-contracts.canonical.json` plus the
 * lock beside it. Nothing here touches the network: the whole point of pinning
 * a digest is that the parity test is deterministic and offline.
 *
 * Bumping the `ref` and the digest in the same commit is the entire approval
 * record for a contract change, so keep that commit small and reviewable.
 *
 * With `[ref]` given, the contracts are read from `git show <ref>:...` so the
 * artifact provably corresponds to a commit. Without it, the working tree is
 * read and the lock records that fact — useful while the muxr side is still
 * in flight, and something the reviewer must reconcile before release.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { buildCanonical, canonicalize } from "../test/support/canonical.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(HERE, "..", "vendor");
const ARTIFACT = join(VENDOR_DIR, "muxr-contracts.canonical.json");
const LOCK = join(VENDOR_DIR, "muxr-contracts.lock.json");
const CONTRACTS_SUBPATH = "packages/contracts";

const clonePath = process.argv[2];
const ref = process.argv[3];
if (!clonePath) {
	console.error(
		"usage: node scripts/refresh-muxr-contracts.mjs <path-to-muxr-clone> [ref]\n" +
			"  <path-to-muxr-clone>  a local checkout or worktree of hank-warren/muxr\n" +
			"  [ref]                 optional commit-ish; omit to read the working tree",
	);
	process.exit(2);
}
const cloneRoot = resolve(clonePath);

const git = (...args) =>
	execFileSync("git", ["-C", cloneRoot, ...args], { encoding: "utf8" }).trim();

const head = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--", CONTRACTS_SUBPATH);

/**
 * Load the contracts module, either from a committed ref or the working tree.
 *
 * A ref is materialised into a scratch directory so the import is unambiguous;
 * the working-tree path is imported in place.
 */
async function loadContracts() {
	if (!ref) {
		const entry = join(cloneRoot, CONTRACTS_SUBPATH, "src", "index.ts");
		return { module: await import(pathToFileURL(entry).href), source: "working-tree" };
	}
	const scratch = mkdtempSync(join(tmpdir(), "muxr-contracts-"));
	try {
		const files = git("ls-tree", "-r", "--name-only", ref, "--", `${CONTRACTS_SUBPATH}/src`)
			.split("\n")
			.filter(Boolean);
		for (const file of files) {
			const target = join(scratch, file.slice(`${CONTRACTS_SUBPATH}/`.length));
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, git("show", `${ref}:${file}`));
		}
		return {
			module: await import(pathToFileURL(join(scratch, "src", "index.ts")).href),
			source: git("rev-parse", ref),
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

const { module, source } = await loadContracts();
const canonical = buildCanonical(module);
const body = `${JSON.stringify(JSON.parse(canonicalize(canonical)), null, 2)}\n`;

mkdirSync(VENDOR_DIR, { recursive: true });
writeFileSync(ARTIFACT, body);
writeFileSync(
	LOCK,
	`${JSON.stringify(
		{
			repo: "hank-warren/muxr",
			ref: ref ? source : head,
			refState: ref ? "commit" : dirty ? "working-tree-dirty" : "working-tree-clean",
			path: `${CONTRACTS_SUBPATH}/contracts.canonical.json`,
			sha256: createHash("sha256").update(body).digest("hex"),
			readAt: new Date().toISOString(),
		},
		null,
		2,
	)}\n`,
);

console.log(`wrote ${ARTIFACT}`);
console.log(`  ref       ${ref ? source : head}`);
console.log(`  refState  ${ref ? "commit" : dirty ? "working-tree-dirty" : "working-tree-clean"}`);
if (!ref && dirty) {
	console.warn(
		"\nWARNING: read uncommitted changes from the muxr working tree.\n" +
			"The lock cannot name a commit that contains them. Re-run with a ref\n" +
			"once the muxr side has landed, and commit the updated artifact.",
	);
}
