import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OptionSelector } from "@hank-warren/pi-permission-selector/selector.ts";
import {
  appendPromptEvaluation,
  classifyPromptChoice,
  EVALUATION_LOG_ROTATE_BYTES,
  expectedDecisionForChoice,
  permissionPromptOptions,
  PROMPT_FEEDBACK_OPTIONS,
  shouldOfferStandingApproval,
  type PromptEvaluationRecord,
} from "../evaluation-log.ts";
import { SIDECAR_ROTATE_BYTES } from "../jsonl-sidecar.ts";
import { scratchDir } from "./support/temp-dir.ts";

function record(
  expectedDecision: "approve" | "ask_user",
  userChoice: PromptEvaluationRecord["userChoice"],
): PromptEvaluationRecord {
  return {
    version: 2,
    timestamp: "2026-04-11T12:00:00.000Z",
    sessionId: "session-1",
    cwd: "/repo",
    tool: "bash",
    gate: { label: "command review", group: "catch-all" },
    userRequest: "USER: inspect Herdr",
    command: "herdr tab",
    relevantContext: [{ key: "u1:0:user", source: "user", text: "USER: inspect Herdr" }],
    actualDecision: "ask_user",
    actualReason: "The command semantics are unclear.",
    decisionSource: "guardian",
    userChoice,
    expectedDecision,
  };
}

test("uses feedback choices only when evaluation logging is enabled", () => {
  assert.deepEqual(permissionPromptOptions(false), ["Allow", "Block"]);
  assert.deepEqual(permissionPromptOptions(true), [
    PROMPT_FEEDBACK_OPTIONS.allowUnnecessary,
    PROMPT_FEEDBACK_OPTIONS.block,
    PROMPT_FEEDBACK_OPTIONS.allowAppropriate,
  ]);
});

test("offers standing approval only for guardian-source prompts", () => {
  assert.equal(shouldOfferStandingApproval("guardian", true), true);
  assert.equal(shouldOfferStandingApproval("guardian", false), false);
  assert.equal(shouldOfferStandingApproval("review_failure", true), false);
  assert.deepEqual(permissionPromptOptions(true, true), [
    PROMPT_FEEDBACK_OPTIONS.allowUnnecessary,
    PROMPT_FEEDBACK_OPTIONS.block,
    PROMPT_FEEDBACK_OPTIONS.allowAppropriate,
    PROMPT_FEEDBACK_OPTIONS.allowStanding,
  ]);
  assert.deepEqual(permissionPromptOptions(false, true), [
    "Allow",
    "Block",
    PROMPT_FEEDBACK_OPTIONS.allowStanding,
  ]);
});

test("the four-option guardian prompt renders within a narrow width", () => {
  const selector = new OptionSelector({
    title: "Remote command — Auto Permissions needs approval",
    options: permissionPromptOptions(true, true).map((value) => ({ value, label: value })),
    onSelect: () => {},
    onCancel: () => {},
    requestRender: () => {},
  });
  const width = 44;
  const lines = selector.render(width).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(lines.some((line) => line.includes("comparable")), "the standing option remains visible after wrapping");
  assert.ok(lines.every((line) => line.length <= width), JSON.stringify(lines));
});

test("the labeled block option carries the em-dash wording", () => {
  // The option string is the API: OptionSelector returns it verbatim and
  // classifyPromptChoice matches it exactly.
  assert.equal(PROMPT_FEEDBACK_OPTIONS.block, "Block — asking was appropriate");
});

test("classifies prompt choices and maps feedback to expected guardian decisions", () => {
  assert.deepEqual(classifyPromptChoice("Allow"), { allowsExecution: true });
  assert.deepEqual(classifyPromptChoice("Block"), {
    allowsExecution: false,
    userChoice: "block",
  }, "plain Block from the logging-disabled prompt still classifies");
  assert.deepEqual(classifyPromptChoice(PROMPT_FEEDBACK_OPTIONS.allowUnnecessary), {
    allowsExecution: true,
    userChoice: "allow_unnecessary",
  });
  assert.deepEqual(classifyPromptChoice(PROMPT_FEEDBACK_OPTIONS.allowAppropriate), {
    allowsExecution: true,
    userChoice: "allow_appropriate",
  });
  assert.deepEqual(classifyPromptChoice(PROMPT_FEEDBACK_OPTIONS.block), {
    allowsExecution: false,
    userChoice: "block",
  });
  assert.deepEqual(classifyPromptChoice(PROMPT_FEEDBACK_OPTIONS.allowStanding), {
    allowsExecution: true,
    userChoice: "allow_unnecessary",
    standingApproval: true,
  });
  assert.equal(classifyPromptChoice(undefined), undefined);
  assert.equal(classifyPromptChoice("unexpected"), undefined);

  assert.equal(expectedDecisionForChoice("allow_unnecessary"), "approve");
  assert.equal(expectedDecisionForChoice("allow_appropriate"), "ask_user");
  assert.equal(expectedDecisionForChoice("block"), "ask_user");
});

test("appends private JSONL evaluation records", () => {
  const dir = scratchDir("pi-auto-permissions-evals-");
  const path = join(dir, "nested", "review-evals.jsonl");

  appendPromptEvaluation(path, record("approve", "allow_unnecessary"));
  appendPromptEvaluation(path, record("ask_user", "allow_appropriate"));
  appendPromptEvaluation(path, record("ask_user", "block"));

  const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].version, 2);
  assert.equal(lines[0].expectedDecision, "approve");
  assert.equal(lines[1].expectedDecision, "ask_user");
  assert.equal(lines[2].expectedDecision, "ask_user");
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("the evaluation log rotates once it reaches its own cap", () => {
  const dir = scratchDir("pi-auto-permissions-evals-");
  const path = join(dir, "review-evals.jsonl");
  writeFileSync(path, `${JSON.stringify(record("ask_user", "block"))}\n`);
  // Below the evaluation cap (at the smaller sidecar cap) nothing rotates.
  truncateSync(path, SIDECAR_ROTATE_BYTES);
  appendPromptEvaluation(path, record("ask_user", "block"));
  assert.ok(!existsSync(`${path}.1`));

  // Sparse file: reported size equals the cap without writing 64 MiB.
  truncateSync(path, EVALUATION_LOG_ROTATE_BYTES);
  const entry = record("approve", "allow_unnecessary");
  appendPromptEvaluation(path, entry);

  assert.equal(statSync(`${path}.1`).size, EVALUATION_LOG_ROTATE_BYTES);
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), entry);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
