import assert from "node:assert/strict";
import { test } from "node:test";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { resolveGuardianCompleteSimple } from "../guardian-transport.ts";

test("uses the registry runtime's completeSimple when reachable, bound to the runtime", async () => {
  const calls: unknown[][] = [];
  const runtime = {
    marker: "runtime",
    completeSimple(this: { marker: string }, ...args: unknown[]) {
      calls.push([this.marker, ...args]);
      return Promise.resolve("runtime-result");
    },
  };

  const resolved = resolveGuardianCompleteSimple({ runtime }, "test-package");
  assert.notEqual(resolved, completeSimple);
  const result = await (resolved as (...args: unknown[]) => Promise<unknown>)("model", "context", "options");
  assert.equal(result, "runtime-result");
  assert.deepEqual(calls, [["runtime", "model", "context", "options"]]);
});

test("falls back to compat completeSimple when the runtime seam is absent", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));
  try {
    assert.equal(resolveGuardianCompleteSimple(undefined, "test-package"), completeSimple);
    assert.equal(resolveGuardianCompleteSimple(null, "test-package"), completeSimple);
    assert.equal(resolveGuardianCompleteSimple({}, "test-package"), completeSimple);
    assert.equal(resolveGuardianCompleteSimple({ runtime: undefined }, "test-package"), completeSimple);
    assert.equal(resolveGuardianCompleteSimple({ runtime: {} }, "test-package"), completeSimple);
    assert.equal(
      resolveGuardianCompleteSimple({ runtime: { completeSimple: "not-a-function" } }, "test-package"),
      completeSimple,
    );
  } finally {
    console.warn = originalWarn;
  }

  // The fallback warning is one-shot per module instance and must name the
  // calling package, since this file is duplicated across packages.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[test-package\] host ModelRuntime completeSimple is unavailable/);
});
