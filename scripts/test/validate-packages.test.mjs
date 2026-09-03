/**
 * Fixture tests for scripts/validate.py's package-shape rules.
 *
 * validate.py walks a whole repository from its own location, so a fixture is
 * a copy of this repository's tracked files with one thing changed. The copy
 * is ~2 MB of text and takes a few milliseconds; the alternative — a synthetic
 * tree — cannot exist, because the validator's inventories name every real
 * package by path.
 *
 * The hybrid rules (an extension *and* its companion skills, pi-loop) are the
 * reason this file exists: they widened three exact-set checks, and an
 * exact-set check that silently stopped covering a package is exactly the
 * failure a green test suite hides.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// Tracked *and* not-yet-committed files, so a fixture validates the working
// tree the way `npm test` does rather than the last commit.
const TRACKED = execFileSync(
  "git",
  ["-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const temps = [];

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the repository's working-tree files, mutated by `edit`, then validated. */
function validate(edit = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "validate-fixture-"));
  temps.push(dir);
  for (const rel of TRACKED) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(ROOT, rel), target);
  }
  edit({
    dir,
    read: (rel) => JSON.parse(readFileSync(join(dir, rel), "utf8")),
    write: (rel, value) => writeFileSync(join(dir, rel), `${JSON.stringify(value, null, 2)}\n`),
    remove: (rel) => rmSync(join(dir, rel), { recursive: true, force: true }),
    replace: (rel, from, to) => {
      const text = readFileSync(join(dir, rel), "utf8");
      assert.ok(text.includes(from), `fixture text not found in ${rel}: ${from}`);
      writeFileSync(join(dir, rel), text.replace(from, to));
    },
    create: (rel, text) => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    },
  });
  const result = spawnSync("python3", [join(dir, "scripts", "validate.py")], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

const HYBRID = "packages/pi-loop/package.json";
const SKILL_MD = "packages/pi-loop/skills/pi-loop/SKILL.md";

test("the working tree validates, hybrid and skill packages included", () => {
  const result = validate();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Structure: ok/);
});

test("a hybrid skill entry with no SKILL.md fails", () => {
  const result = validate(({ remove }) => remove(SKILL_MD));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skill entry has no SKILL.md: \.\/skills\/pi-loop/);
});

test("a frontmatter name that does not match the directory fails", () => {
  const result = validate(({ replace }) => replace(SKILL_MD, "name: pi-loop", "name: loop"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /frontmatter name 'loop' must match directory name 'pi-loop'/);
});

test("a hybrid skill missing from the files allowlist fails", () => {
  const result = validate(({ read, write }) => {
    const pkg = read(HYBRID);
    pkg.files = pkg.files.filter((entry) => entry !== "skills");
    write(HYBRID, pkg);
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skill missing from files allowlist: \.\/skills\/pi-loop/);
});

test("a hybrid manifest that drops its extensions entry fails", () => {
  const result = validate(({ read, write }) => {
    const pkg = read(HYBRID);
    pkg.pi = { skills: pkg.pi.skills };
    write(HYBRID, pkg);
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hybrid pi manifest must expose extensions and skills/);
});

test("a hybrid manifest with no skills fails", () => {
  const result = validate(({ read, write }) => {
    const pkg = read(HYBRID);
    pkg.pi.skills = [];
    write(HYBRID, pkg);
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hybrid package must declare at least one skill/);
});

test("a hybrid package still obeys extension peerDependency rules", () => {
  const result = validate(({ read, write }) => {
    const pkg = read(HYBRID);
    pkg.peerDependencies = {};
    write(HYBRID, pkg);
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /peerDependencies must be a non-empty subset/);
});

test("root pi.skills drift fails in both directions", () => {
  const dropped = validate(({ read, write }) => {
    const root = read("package.json");
    root.pi.skills = root.pi.skills.filter((entry) => !entry.includes("pi-loop"));
    write("package.json", root);
  });
  assert.equal(dropped.status, 1);
  assert.match(dropped.stderr, /pi\.skills must exactly re-export every skill-package skill/);

  const invented = validate(({ read, write }) => {
    const root = read("package.json");
    root.pi.skills = [...root.pi.skills, "./packages/pi-loop/skills/pi-nope"];
    write("package.json", root);
  });
  assert.equal(invented.status, 1);
  assert.match(invented.stderr, /pi\.skills must exactly re-export every skill-package skill/);
});

test("the skill-only package's own rules survive the shared-entry refactor", () => {
  const result = validate(({ replace }) => {
    replace("packages/pi-simplify/simplify/SKILL.md", "name: simplify", "name: simplify-x");
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /frontmatter name 'simplify-x' must match directory name 'simplify'/);
});

// Node alignment. pi requires >=22.19.0, so a package advertising anything else
// is telling a host it can run somewhere it cannot. The skill-only package
// declares no engines at all, and the "working tree validates" test above is
// what pins that exemption.
test("a package whose engines.node drifts from pi's floor fails", () => {
  const result = validate(({ read, write }) => {
    const pkg = read("packages/pi-stats/package.json");
    pkg.engines = { node: ">=18.0.0" };
    write("packages/pi-stats/package.json", pkg);
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pi-stats: engines\.node must be '>=22\.19\.0', found '>=18\.0\.0'/);
});

test("a package with no engines at all fails", () => {
  const result = validate(({ read, write }) => {
    const pkg = read("packages/pi-stats/package.json");
    delete pkg.engines;
    write("packages/pi-stats/package.json", pkg);
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pi-stats: engines\.node must be '>=22\.19\.0', found None/);
});

test("a skill-only package that declares engines fails", () => {
  const result = validate(({ read, write }) => {
    const pkg = read("packages/pi-simplify/package.json");
    pkg.engines = { node: ">=22.19.0" };
    write("packages/pi-simplify/package.json", pkg);
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pi-simplify: skill-only packages declare no engines/);
});

test("the copy-to-create template carries the same engines value", () => {
  const result = validate(({ read, write }) => {
    const pkg = read("docs/template-package/package.json");
    pkg.engines = { node: ">=18.0.0" };
    write("docs/template-package/package.json", pkg);
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /docs\/template-package: engines\.node must be '>=22\.19\.0', found '>=18\.0\.0'/,
  );
});

// npm ci fails on a workspace member missing from the lockfile, and it does so
// in the publish run rather than in a pull request. Catching it here moves that
// failure back to `npm test`.
test("a workspace member missing from the lockfile fails and is named", () => {
  const result = validate(({ read, write }) => {
    const lock = read("package-lock.json");
    delete lock.packages["node_modules/@hank-warren/pi-loop"];
    write("package-lock.json", lock);
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /workspace member missing from the lockfile: @hank-warren\/pi-loop \(packages\/pi-loop\)/,
  );
});

// The shared harness carve-out, both directions: a package test may climb out to
// ROOT/test/support/ and nothing else may climb out anywhere.
test("a package test importing a sibling package's sources fails", () => {
  const result = validate(({ create }) => {
    create(
      "packages/pi-stash/test/probe.test.ts",
      'import { formatTokens } from "../../pi-stats/stats.js";\nvoid formatTokens;\n',
    );
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /packages\/pi-stash\/test\/probe\.test\.ts: cross-package source import: \.\.\/\.\.\/pi-stats\/stats\.js/,
  );
});

test("a package test importing the shared harness is allowed", () => {
  const result = validate(({ create }) => {
    create(
      "packages/pi-stash/test/probe.test.ts",
      'import { createMockPi } from "../../../test/support/mock-pi.js";\nvoid createMockPi;\n',
    );
  });
  assert.equal(result.status, 0, result.stderr);
});

test("a package *source* importing the shared harness still fails", () => {
  const result = validate(({ create }) => {
    create(
      "packages/pi-stash/probe.ts",
      'import { createMockPi } from "../../test/support/mock-pi.js";\nvoid createMockPi;\n',
    );
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /packages\/pi-stash\/probe\.ts: cross-package source import/);
});

// The carve-out is one-way. Laundering a sibling's sources through the shared
// harness would otherwise satisfy both halves of the cross-package rule.
test("shared test support importing a package's sources fails", () => {
  const result = validate(({ create }) => {
    create(
      "test/support/probe.ts",
      'export { formatTokens } from "../../packages/pi-stats/stats.js";\n',
    );
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /test\/support\/probe\.ts: shared test support may not import package sources: \.\.\/\.\.\/packages\/pi-stats\/stats\.js/,
  );
});

test("shared test support importing node and pi modules is allowed", () => {
  const result = validate(({ create }) => {
    create(
      "test/support/probe.ts",
      'import { join } from "node:path";\nimport { Key } from "@earendil-works/pi-tui";\nimport { CLEARED } from "./probe-sibling.js";\nexport const probe = [join, Key, CLEARED];\n',
    );
    create("test/support/probe-sibling.ts", "export const CLEARED = [];\n");
  });
  assert.equal(result.status, 0, result.stderr);
});
