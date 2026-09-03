import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PLAIN_PALETTE,
  reviewFrameIntervalMs,
  reviewStatusFrame,
  reviewStatusLines,
  WAITING_FRAME_INTERVAL_MS,
  WAITING_FRAMES,
} from "../widget-status.js";

const REVIEWER = "openai-codex/gpt-5.6-luna";

describe("reviewStatusFrame", () => {
  it("cycles waiting sparkle frames and never finishes", () => {
    for (let index = 0; index < WAITING_FRAMES.length * 2; index++) {
      const frame = reviewStatusFrame("waiting", REVIEWER, index);
      assert.equal(frame.glyph, WAITING_FRAMES[index % WAITING_FRAMES.length]);
      assert.equal(frame.label, `waiting for ${REVIEWER}`);
      assert.equal(frame.tone, "warning");
      assert.equal(frame.done, false);
    }
  });

  it("wraps waiting frames past the array length", () => {
    const wrapped = reviewStatusFrame("waiting", REVIEWER, WAITING_FRAMES.length);
    assert.equal(wrapped.glyph, WAITING_FRAMES[0]);
  });

  it("clamps negative and fractional frame indices", () => {
    assert.equal(reviewStatusFrame("waiting", REVIEWER, -3).glyph, WAITING_FRAMES[0]);
    assert.equal(reviewStatusFrame("waiting", REVIEWER, 1.9).glyph, WAITING_FRAMES[1]);
  });

  it("shows a static checkmark immediately on approval", () => {
    for (const index of [0, 1, 50]) {
      const frame = reviewStatusFrame("approved", REVIEWER, index);
      assert.equal(frame.glyph, "✓");
      assert.equal(frame.label, "approved");
      assert.equal(frame.tone, "success");
      assert.equal(frame.done, true);
    }
  });

  it("returns static frames for the other terminal states", () => {
    assert.deepEqual(reviewStatusFrame("revise", REVIEWER, 0), {
      glyph: "↻",
      label: "revision requested",
      tone: "warning",
      done: true,
    });
    assert.deepEqual(reviewStatusFrame("ask_user", REVIEWER, 0), {
      glyph: "?",
      label: "waiting for your approval",
      tone: "accent",
      done: true,
    });
    assert.deepEqual(reviewStatusFrame("blocked", REVIEWER, 0), {
      glyph: "✗",
      label: "blocked",
      tone: "error",
      done: true,
    });
  });
});

describe("reviewFrameIntervalMs", () => {
  it("animates only the waiting state", () => {
    assert.equal(reviewFrameIntervalMs("waiting"), WAITING_FRAME_INTERVAL_MS);
    assert.equal(reviewFrameIntervalMs("approved"), undefined);
    assert.equal(reviewFrameIntervalMs("revise"), undefined);
    assert.equal(reviewFrameIntervalMs("ask_user"), undefined);
    assert.equal(reviewFrameIntervalMs("blocked"), undefined);
  });
});

describe("reviewStatusLines", () => {
  it("renders a single collapsed line without the command", () => {
    const lines = reviewStatusLines("waiting", "command review", REVIEWER, 0, undefined, PLAIN_PALETTE);
    assert.deepEqual(lines, [
      `auto permissions · command review · ${WAITING_FRAMES[0]} waiting for ${REVIEWER}`,
    ]);
    assert.ok(!lines.some((line) => line.includes("$")));
  });

  it("queued is static, muted, and never animates", () => {
    // A second guarded command in the same turn waits behind the first, which
    // may itself be waiting on a human. It must render something rather than a
    // blank gap — but not a spinner, which would promise progress it is not
    // making. Static across every frame index, and no frame interval.
    const first = reviewStatusFrame("queued", REVIEWER, 0);
    assert.deepEqual(first, {
      glyph: "⋯",
      label: "queued behind another review",
      tone: "muted",
      done: true,
    });
    for (const index of [1, 2, 7, 99]) {
      assert.deepEqual(reviewStatusFrame("queued", REVIEWER, index), first, "static across frames");
    }
    assert.equal(reviewFrameIntervalMs("queued"), undefined, "nothing to animate");
  });

  it("renders a queued row through the muted palette entry", () => {
    const palette = { ...PLAIN_PALETTE, muted: (text: string) => `[m]${text}[/m]` };
    const lines = reviewStatusLines("queued", "command review", REVIEWER, 0, undefined, palette);
    assert.deepEqual(lines, [
      `auto permissions [m]· command review ·[/m] [m]⋯ queued behind another review[/m]`,
    ]);
  });

  it("adds a detail second line only when present", () => {
    const withDetail = reviewStatusLines("approved", "command review", REVIEWER, 0, "approved by user", PLAIN_PALETTE);
    assert.deepEqual(withDetail, [
      "auto permissions · command review · ✓ approved",
      "approved by user",
    ]);
    const withoutDetail = reviewStatusLines("blocked", "command review", REVIEWER, 0, undefined, PLAIN_PALETTE);
    assert.equal(withoutDetail.length, 1);
  });

  it("applies the palette to each segment", () => {
    const palette = {
      header: (text: string) => `[h]${text}[/h]`,
      muted: (text: string) => `[m]${text}[/m]`,
      warning: (text: string) => `[w]${text}[/w]`,
      success: (text: string) => `[s]${text}[/s]`,
      accent: (text: string) => `[a]${text}[/a]`,
      error: (text: string) => `[e]${text}[/e]`,
    };
    const lines = reviewStatusLines("waiting", "command review", REVIEWER, 1, "checking", palette);
    assert.deepEqual(lines, [
      `[h]auto permissions[/h] [m]· command review ·[/m] [w]${WAITING_FRAMES[1]} waiting for ${REVIEWER}[/w]`,
      "[m]checking[/m]",
    ]);
  });
});
