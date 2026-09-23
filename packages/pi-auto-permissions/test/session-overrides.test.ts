import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockPi } from "../../../test/support/mock-pi.ts";
import { loadAutoPermissionsConfig } from "../config.ts";
import type { ReviewScope } from "../review-scope.ts";
import { createSessionOverrides } from "../session-overrides.ts";

const OVERRIDES_ENTRY_TYPE = "auto-permissions-overrides";

function scope(): ReviewScope {
  return {
    ctx: { cwd: "/work", ui: { notify() {} } } as never,
    config: loadAutoPermissionsConfig(join(tmpdir(), "missing-session-overrides-config.json")),
    gate: { pattern: /git push/, level: "guarded", group: "git", label: "Push" },
    command: "git push origin main",
    target: {} as never,
  };
}

function overrideEntries(mock: ReturnType<typeof createMockPi>) {
  return mock.entries.filter((entry) => entry.customType === OVERRIDES_ENTRY_TYPE);
}

test("a non-standing prompt decision persists exactly once", () => {
  const mock = createMockPi();
  const overrides = createSessionOverrides(mock.pi);
  overrides.recordPromptDecision(scope(), { allowsExecution: true, userChoice: "allow_appropriate" }, "risky", "k1");

  assert.equal(overrideEntries(mock).length, 1);
  assert.deepEqual(overrides.list(), [{
    seq: 0,
    anchorKey: "k1",
    gateLabel: "Push",
    command: "git push origin main",
    reviewerReason: "risky",
    choice: "allow_appropriate",
  }]);
});

test("a decision with no override choice persists nothing", () => {
  const mock = createMockPi();
  const overrides = createSessionOverrides(mock.pi);
  overrides.recordPromptDecision(scope(), { allowsExecution: false }, "risky", undefined);

  assert.equal(overrideEntries(mock).length, 0);
  assert.equal(overrides.list().length, 0);
});

test("allow on retry persists exactly once before the nudge", () => {
  const mock = createMockPi();
  const overrides = createSessionOverrides(mock.pi);
  overrides.allowRetry(
    { id: "d1", ts: "2026-09-24T00:00:00.000Z", gateLabel: "Push", command: "git push", verdict: "block", reason: "no" },
    undefined,
  );

  assert.equal(overrideEntries(mock).length, 1);
  assert.equal(mock.sentUserMessages.length, 1);
  assert.equal(overrides.list()[0]?.choice, "allow");
});
