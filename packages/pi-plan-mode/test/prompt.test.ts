/**
 * The Plan-mode prompt must name exactly one question tool.
 *
 * Naming both is the failure that matters: the model reads the prompt, sees a
 * tool it cannot call (because `plan_mode_question` is stripped from the active
 * set whenever `ask_user_question` is installed), and either calls it and gets
 * an error or asks in plain chat instead of using the dialog.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import test from "node:test";
import {
	ASK_USER_QUESTION_TOOL,
	buildPlanModePrompt,
	PLAN_CRAFT_DOC,
	PLAN_MODE_QUESTION_TOOL,
} from "../src/prompt.js";

/** Both names, so "mentions exactly one" can be asserted in either direction. */
const TOOLS = [PLAN_MODE_QUESTION_TOOL, ASK_USER_QUESTION_TOOL];

function mentioned(prompt: string): string[] {
	return TOOLS.filter((name) => prompt.includes(name));
}

test("the default prompt is the legacy one, verbatim in its bounds", () => {
	const prompt = buildPlanModePrompt();
	assert.deepEqual(mentioned(prompt), [PLAN_MODE_QUESTION_TOOL]);
	assert.match(prompt, /Ask 1-3 concise questions with 2-4 meaningful options\./);
	assert.match(prompt, /If plan_mode_question returns cancelled or ui_unavailable/);
});

test("passing the legacy tool explicitly matches the default", () => {
	assert.equal(buildPlanModePrompt(PLAN_MODE_QUESTION_TOOL), buildPlanModePrompt());
});

test("the ask_user_question prompt carries that tool's own bounds", () => {
	const prompt = buildPlanModePrompt(ASK_USER_QUESTION_TOOL);
	assert.deepEqual(mentioned(prompt), [ASK_USER_QUESTION_TOOL]);
	assert.match(prompt, /Ask 1-4 concise questions with 2-4 meaningful options each/);
	assert.match(prompt, /2-6 options when the question sets multiSelect/);
	assert.ok(!prompt.includes("1-3 concise questions"), "the legacy bounds must not leak");
});

test("the decline wording follows the tool", () => {
	const prompt = buildPlanModePrompt(ASK_USER_QUESTION_TOOL);
	assert.match(prompt, /If ask_user_question reports that the user declined to answer/);
	assert.ok(!prompt.includes("ui_unavailable"), "that is a plan_mode_question-only signal");
});

test("every question-tool reference switches together", () => {
	// Phase 3 ask, Phase 3 decline, Ending-each-turn, Completion rule.
	const prompt = buildPlanModePrompt(ASK_USER_QUESTION_TOOL);
	const occurrences = prompt.split(ASK_USER_QUESTION_TOOL).length - 1;
	assert.equal(occurrences, 4, `expected four references, found ${occurrences}`);
});

test("an unknown tool name falls back to the legacy prompt rather than naming it", () => {
	const prompt = buildPlanModePrompt("some_other_tool");
	assert.deepEqual(mentioned(prompt), [PLAN_MODE_QUESTION_TOOL]);
	assert.ok(!prompt.includes("some_other_tool"));
});

test("everything outside the question-tool references is identical between modes", () => {
	const legacy = buildPlanModePrompt();
	const preferred = buildPlanModePrompt(ASK_USER_QUESTION_TOOL);
	assert.equal(
		legacy.split("\n").length,
		preferred.split("\n").length,
		"only wording changes; the prompt structure is the same document",
	);
	for (const line of ["## Completion rule", "## Ending each turn", "[PLAN MODE ACTIVE]"]) {
		assert.ok(preferred.includes(line), `${line} must survive the rewrite`);
	}
});

test("the prompt points at the plan-craft doc, once, by absolute path", () => {
	// The doc replaced a skill: a skill's description line was paid by every
	// session and observed to trigger nothing, where a pointer injected only
	// while Plan Mode is active costs nothing outside it. The pointer has to be
	// a real absolute path, because "read the X skill if it is available" gave
	// the model a way to skip it.
	assert.ok(isAbsolute(PLAN_CRAFT_DOC));
	assert.ok(existsSync(PLAN_CRAFT_DOC), `${PLAN_CRAFT_DOC} is not shipped`);
	for (const tool of [null, PLAN_MODE_QUESTION_TOOL, ASK_USER_QUESTION_TOOL]) {
		const prompt = buildPlanModePrompt(tool);
		assert.ok(prompt.includes(`read ${PLAN_CRAFT_DOC}`));
	}
});
