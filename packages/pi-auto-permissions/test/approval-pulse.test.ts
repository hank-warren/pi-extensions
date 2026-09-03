import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPROVAL_PULSE_INTERVAL_MS,
  PulsingApprovalIndicator,
  type ApprovalPulseScheduler,
} from "../approval-pulse.js";

class ChildComponent {
  inputs: string[] = [];
  invalidations = 0;

  render(): string[] {
    return ["unadorned title", "", "→ 1. Allow"];
  }

  handleInput(data: string): void {
    this.inputs.push(data);
  }

  invalidate(): void {
    this.invalidations += 1;
  }
}

function harness() {
  let tick: (() => void) | undefined;
  const cleared: unknown[] = [];
  const intervals: number[] = [];
  const scheduler: ApprovalPulseScheduler = {
    setInterval(callback, intervalMs) {
      tick = callback;
      intervals.push(intervalMs);
      return "pulse-timer";
    },
    clearInterval(handle) {
      cleared.push(handle);
    },
  };
  const child = new ChildComponent();
  let renders = 0;
  const indicator = new PulsingApprovalIndicator(
    "Git push — Auto Permissions needs approval",
    child,
    {
      fg: (role, text) => `<${role}>${text}</${role}>`,
      bold: (text) => `<bold>${text}</bold>`,
    },
    () => {
      renders += 1;
    },
    scheduler,
  );
  return { child, cleared, indicator, intervals, renders: () => renders, tick: () => tick?.() };
}

describe("PulsingApprovalIndicator", () => {
  it("replaces only the selector heading with a bright approval light", () => {
    const h = harness();
    assert.deepEqual(h.indicator.render(100), [
      "<warning><bold>●</bold></warning> Git push — Auto Permissions needs approval",
      "",
      "→ 1. Allow",
    ]);
  });

  it("pulses bright and dim at the configured interval", () => {
    const h = harness();
    h.indicator.start();
    assert.equal(h.indicator.isRunning(), true);
    assert.deepEqual(h.intervals, [APPROVAL_PULSE_INTERVAL_MS]);

    h.tick();
    assert.equal(h.renders(), 1);
    assert.match(h.indicator.render(100)[0] ?? "", /^<dim>●<\/dim>/);

    h.tick();
    assert.equal(h.renders(), 2);
    assert.match(h.indicator.render(100)[0] ?? "", /^<warning><bold>●/);
  });

  it("clears its timer exactly once when stopped", () => {
    const h = harness();
    h.indicator.start();
    h.indicator.start();
    assert.deepEqual(h.intervals, [APPROVAL_PULSE_INTERVAL_MS], "start must be idempotent");

    h.indicator.stop();
    h.indicator.stop();
    assert.equal(h.indicator.isRunning(), false);
    assert.deepEqual(h.cleared, ["pulse-timer"]);
  });

  it("keeps selector input and invalidation behavior intact", () => {
    const h = harness();
    h.indicator.handleInput("2");
    h.indicator.invalidate();
    assert.deepEqual(h.child.inputs, ["2"]);
    assert.equal(h.child.invalidations, 1);
  });
});
