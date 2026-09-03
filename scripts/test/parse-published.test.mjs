import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { classifyPublish, parsePublished } from "../parse-published.mjs";

const SCRIPT = fileURLToPath(new URL("../parse-published.mjs", import.meta.url));

test("parses a scoped package name", () => {
  const log = "🦋  New tag:  @hank-warren/pi-stats@0.3.2\n";
  assert.deepEqual(parsePublished(log), [{ name: "@hank-warren/pi-stats", version: "0.3.2" }]);
});

test("parses every tag from a multi-package publish, in order", () => {
  const log = [
    "🦋  info npm info @hank-warren/pi-stats",
    "🦋  success packages published successfully:",
    "🦋  @hank-warren/pi-stats@0.3.2",
    "🦋  @hank-warren/pi-statusline@0.2.3",
    "🦋  Creating git tags...",
    "🦋  New tag:  @hank-warren/pi-stats@0.3.2",
    "🦋  New tag:  @hank-warren/pi-statusline@0.2.3",
    "🦋  New tag:  unscoped-package@1.0.0-rc.1",
  ].join("\n");
  assert.deepEqual(parsePublished(log), [
    { name: "@hank-warren/pi-stats", version: "0.3.2" },
    { name: "@hank-warren/pi-statusline", version: "0.2.3" },
    { name: "unscoped-package", version: "1.0.0-rc.1" },
  ]);
});

test("returns an empty array when nothing was published", () => {
  const log = "🦋  info No unpublished projects to publish\n";
  assert.deepEqual(parsePublished(log), []);
  assert.deepEqual(parsePublished(""), []);
});

test("is not affected by regex lastIndex across calls", () => {
  const log = "New tag:  @hank-warren/pi-stats@0.3.2\n";
  assert.deepEqual(parsePublished(log), parsePublished(log));
});

test("cli reads a log file and writes JSON to stdout", () => {
  const dir = mkdtempSync(join(tmpdir(), "parse-published-"));
  const logPath = join(dir, "publish.log");
  writeFileSync(logPath, "New tag:  @hank-warren/pi-plan-mode@0.4.0\nNew tag:  pkg@1.2.3\n");
  const out = execFileSync(process.execPath, [SCRIPT, logPath], { encoding: "utf8" });
  assert.equal(
    out,
    '[{"name":"@hank-warren/pi-plan-mode","version":"0.4.0"},{"name":"pkg","version":"1.2.3"}]',
  );
});

test("cli reads stdin when no file argument is given", () => {
  const out = execFileSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    input: "New tag:  @hank-warren/pi-grok-auth@0.2.0\n",
  });
  assert.equal(out, '[{"name":"@hank-warren/pi-grok-auth","version":"0.2.0"}]');
});

test("cli emits an empty array for no-match input", () => {
  const out = execFileSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    input: "🦋  info No unpublished projects to publish\n",
  });
  assert.equal(out, "[]");
});

// Verbatim from run 32062263313, which went red minutes after
// @hank-warren/pi-model-fallback@0.2.0 published successfully: `npm info` still
// 404ed the brand-new package name, so changesets re-attempted a version npm
// already had. Colour codes are kept so the ANSI stripping stays covered.
const FIRST_PUBLISH_LAG_LOG = [
  '🦋  \u001b[33mwarn\u001b[39m Received 404 for npm info \u001b[36m"@hank-warren/pi-model-fallback"\u001b[39m',
  "🦋  \u001b[33mwarn\u001b[39m @hank-warren/pi-stats is not being published because version 0.3.3 is already published on npm",
  "🦋  \u001b[36minfo\u001b[39m @hank-warren/pi-model-fallback is being published because our local version (0.2.0) has not been published on npm",
  '🦋  \u001b[36minfo\u001b[39m Publishing \u001b[36m"@hank-warren/pi-model-fallback"\u001b[39m at \u001b[32m"0.2.0"\u001b[39m',
  "🦋  \u001b[31merror\u001b[39m an error occurred while publishing @hank-warren/pi-model-fallback: E403 403 Forbidden - PUT https://registry.npmjs.org/@hank-warren%2fpi-model-fallback - You cannot publish over the previously published versions: 0.2.0. ",
  "🦋  \u001b[31merror\u001b[39m In most cases, you or one of your dependencies are requesting",
  "🦋  \u001b[31merror\u001b[39m npm error code E403",
  "🦋  \u001b[31merror\u001b[39m ",
  "🦋  \u001b[31merror\u001b[39m packages failed to publish:",
  "🦋  @hank-warren/pi-model-fallback@0.2.0",
  "",
].join("\n");

test("classifies an already-published E403 as benign, not a failure", () => {
  assert.deepEqual(classifyPublish(FIRST_PUBLISH_LAG_LOG), {
    published: [],
    alreadyPublished: [{ name: "@hank-warren/pi-model-fallback", version: "0.2.0" }],
    failed: [],
  });
});

test("keeps successful publishes alongside a benign E403", () => {
  const log = [
    "🦋  success packages published successfully:",
    "🦋  @hank-warren/pi-stats@0.3.4",
    "🦋  Creating git tags...",
    "🦋  New tag:  @hank-warren/pi-stats@0.3.4",
    FIRST_PUBLISH_LAG_LOG,
  ].join("\n");
  assert.deepEqual(classifyPublish(log), {
    published: [{ name: "@hank-warren/pi-stats", version: "0.3.4" }],
    alreadyPublished: [{ name: "@hank-warren/pi-model-fallback", version: "0.2.0" }],
    failed: [],
  });
});

test("a real failure stays in failed", () => {
  const log = [
    "🦋  error an error occurred while publishing @hank-warren/pi-stats: E402 You must sign up for private packages",
    "🦋  error packages failed to publish:",
    "🦋  @hank-warren/pi-stats@0.3.4",
  ].join("\n");
  assert.deepEqual(classifyPublish(log), {
    published: [],
    alreadyPublished: [],
    failed: [{ name: "@hank-warren/pi-stats", version: "0.3.4" }],
  });
});

test("a non-duplicate E403 stays in failed", () => {
  const log = [
    "🦋  error an error occurred while publishing @hank-warren/pi-stats: E403 403 Forbidden - PUT https://registry.npmjs.org/@hank-warren%2fpi-stats - You do not have permission to publish",
    "🦋  error packages failed to publish:",
    "🦋  @hank-warren/pi-stats@0.3.4",
  ].join("\n");
  assert.deepEqual(classifyPublish(log).failed, [
    { name: "@hank-warren/pi-stats", version: "0.3.4" },
  ]);
});

test("an E403 for a different version does not excuse the failed one", () => {
  const log = [
    "🦋  error an error occurred while publishing @hank-warren/pi-stats: E403 403 Forbidden - You cannot publish over the previously published versions: 0.3.3.",
    "🦋  error packages failed to publish:",
    "🦋  @hank-warren/pi-stats@0.3.4",
  ].join("\n");
  assert.deepEqual(classifyPublish(log).failed, [
    { name: "@hank-warren/pi-stats", version: "0.3.4" },
  ]);
});

test("an E403 for a different package does not excuse the failed one", () => {
  const log = [
    "🦋  error an error occurred while publishing @hank-warren/pi-plan-mode: E403 403 Forbidden - You cannot publish over the previously published versions: 0.3.4.",
    "🦋  error packages failed to publish:",
    "🦋  @hank-warren/pi-stats@0.3.4",
  ].join("\n");
  assert.deepEqual(classifyPublish(log).failed, [
    { name: "@hank-warren/pi-stats", version: "0.3.4" },
  ]);
});

test("splits a mixed batch of benign and real failures", () => {
  const log = [
    "🦋  error an error occurred while publishing @hank-warren/pi-stats: E403 403 Forbidden - You cannot publish over the previously published versions: 0.3.4.",
    "🦋  error an error occurred while publishing @hank-warren/pi-plan-mode: E500 registry unavailable",
    "🦋  error packages failed to publish:",
    "🦋  @hank-warren/pi-stats@0.3.4",
    "🦋  @hank-warren/pi-plan-mode@1.0.2",
  ].join("\n");
  assert.deepEqual(classifyPublish(log), {
    published: [],
    alreadyPublished: [{ name: "@hank-warren/pi-stats", version: "0.3.4" }],
    failed: [{ name: "@hank-warren/pi-plan-mode", version: "1.0.2" }],
  });
});

test("reads the version list past dots, commas and trailing detail", () => {
  const log = [
    "🦋  error an error occurred while publishing @hank-warren/pi-stats: E403 403 Forbidden - You cannot publish over the previously published versions: 0.3.3, 0.3.4. In most cases, you or one of your dependencies are requesting",
    "🦋  error packages failed to publish:",
    "🦋  @hank-warren/pi-stats@0.3.4",
  ].join("\n");
  assert.deepEqual(classifyPublish(log).alreadyPublished, [
    { name: "@hank-warren/pi-stats", version: "0.3.4" },
  ]);
});

test("a drifted failure block classifies nothing, so the caller fails closed", () => {
  const log = [
    "🦋  error an error occurred while publishing @hank-warren/pi-stats: E403 403 Forbidden - You cannot publish over the previously published versions: 0.3.4.",
    "🦋  error some future changesets wording:",
    "🦋  @hank-warren/pi-stats@0.3.4",
  ].join("\n");
  assert.deepEqual(classifyPublish(log), { published: [], alreadyPublished: [], failed: [] });
});

test("a clean publish classifies as all-published", () => {
  const log = [
    "🦋  success packages published successfully:",
    "🦋  @hank-warren/pi-stats@0.3.4",
    "🦋  New tag:  @hank-warren/pi-stats@0.3.4",
  ].join("\n");
  assert.deepEqual(classifyPublish(log), {
    published: [{ name: "@hank-warren/pi-stats", version: "0.3.4" }],
    alreadyPublished: [],
    failed: [],
  });
});

test("cli --classify emits the three buckets as JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "parse-published-"));
  const logPath = join(dir, "publish.log");
  writeFileSync(logPath, FIRST_PUBLISH_LAG_LOG);
  const out = execFileSync(process.execPath, [SCRIPT, "--classify", logPath], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), {
    published: [],
    alreadyPublished: [{ name: "@hank-warren/pi-model-fallback", version: "0.2.0" }],
    failed: [],
  });
});
