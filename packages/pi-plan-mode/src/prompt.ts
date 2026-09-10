import { join } from "node:path";

/**
 * The plan-craft document: what decision-complete means, why exploration comes
 * before questions, what separates a question worth asking from one the
 * repository already answers, and what a finished plan contains.
 *
 * It used to ship as a skill. A skill buys one thing an injected pointer
 * cannot: a description line in every system prompt, so the model could
 * propose planning unprompted. Across ~220 sessions after it shipped, every
 * read of the file happened after the Plan mode prompt was already active —
 * never off the description — and the model never suggested `/plan` on its
 * own. So the line was a tax on every session that never planned (~95% of
 * them) and bought nothing. An absolute path, injected only while Plan mode
 * is active, is the same document at zero cost outside it, and a hard path
 * beats "if it is available".
 *
 * Resolved from this module's own location so it survives every install
 * layout (git, npm, workspace symlink, `npm link`).
 */
export const PLAN_CRAFT_DOC = join(import.meta.dirname, "..", "docs", "plan-craft.md");

const PLAN_CONTEXT_MARKER = "[PLAN MODE ACTIVE]";

/** The built-in question tool. Used whenever nothing better is installed. */
export const PLAN_MODE_QUESTION_TOOL = "plan_mode_question";
/**
 * `@hank-warren/pi-ask-user-question`'s tool. Detected by name at runtime, with
 * no dependency on that package: previews, notes, tabs, digit hotkeys and
 * checkbox multi-select are all things `plan_mode_question` cannot offer.
 */
export const ASK_USER_QUESTION_TOOL = "ask_user_question";

/**
 * The bits of prompt text that differ between the two question tools. Every
 * reference to a question tool in the prompt is built from one of these, so the
 * prompt can never name one tool's bounds beside the other tool's name.
 */
interface QuestionToolProfile {
	name: string;
	/** How many questions and options the tool actually accepts. */
	bounds: string;
	/** What the model sees when the user does not answer. */
	decline: string;
}

const QUESTION_TOOL_PROFILES: Record<string, QuestionToolProfile> = {
	[PLAN_MODE_QUESTION_TOOL]: {
		name: PLAN_MODE_QUESTION_TOOL,
		bounds: "Ask 1-3 concise questions with 2-4 meaningful options.",
		decline: `If ${PLAN_MODE_QUESTION_TOOL} returns cancelled or ui_unavailable`,
	},
	[ASK_USER_QUESTION_TOOL]: {
		name: ASK_USER_QUESTION_TOOL,
		bounds:
			"Ask 1-4 concise questions with 2-4 meaningful options each, or 2-6 options when the question sets multiSelect.",
		decline: `If ${ASK_USER_QUESTION_TOOL} reports that the user declined to answer`,
	},
};

/**
 * Build the Plan mode prompt around whichever question tool is available.
 *
 * The prompt is the enforcement surface and the turn contract; the craft it
 * used to restate (phases, question quality, plan structure) lives in
 * `PLAN_CRAFT_DOC` and is named here once rather than paid for every turn.
 *
 * The default keeps the exported function callable with no arguments and keeps
 * a standalone `pi-plan-mode` install reading exactly as it did before.
 *
 * Passing `null` builds the headless variant: no interactive question tool is
 * active in that session, so naming one would tell the model to call a tool it
 * cannot see. It asks in plain text instead.
 */
export function buildPlanModePrompt(questionTool: string | null = PLAN_MODE_QUESTION_TOOL) {
	const tool =
		questionTool === null
			? undefined
			: (QUESTION_TOOL_PROFILES[questionTool] ??
				QUESTION_TOOL_PROFILES[PLAN_MODE_QUESTION_TOOL]);
	const askBullet = tool
		? `Use ${tool.name} for important preferences, tradeoffs, or assumption locks that cannot be discovered by non-mutating exploration. ${tool.bounds} Do not include filler options.`
		: "This session has no interactive question tool, so ask in plain text: put important preferences, tradeoffs, or assumption locks that non-mutating exploration cannot settle in your reply as 1-3 concise questions with 2-4 meaningful options each. Do not include filler options, and never call a question tool that is not in your tool set.";
	const declineBullet = tool
		? `${tool.decline}, do not jump straight to a final plan when the missing answer is high impact. Ask one concise plain-text question or proceed only with a clearly stated low-risk assumption.`
		: "If the question goes unanswered, do not jump straight to a final plan when the missing answer is high impact. Ask it again more concisely, or proceed only with a clearly stated low-risk assumption recorded in the plan.";
	const endingBullet = tool
		? `If a material decision remains, use ${tool.name}.`
		: "If a material decision remains, ask one concise plain-text question.";
	const revisionClause = tool
		? `continue planning with ${tool.name} instead of calling plan_mode_complete`
		: "continue planning with a plain-text question instead of calling plan_mode_complete";
	return `${PLAN_CONTEXT_MARKER}
# Plan mode

You are in Plan mode, a collaboration mode for producing a decision-complete implementation plan: one a competent implementer could execute without asking anything further. Chat your way to the plan before finalizing it.

## Mode rules

- Before planning, read ${PLAN_CRAFT_DOC}. It carries the craft this prompt does not repeat: what decision-complete means, why exploration comes before questions, what separates a question worth asking from one the repository already answers, and what a finished plan contains.
- Stay in Plan mode until a developer or extension explicitly exits it.
- Treat requests to implement as requests to plan the implementation; do not edit files or carry out the plan.
- Do not perform mutating actions: no edit/write tools, no patching, no formatting that rewrites files, no dependency installation, no commits, no migrations.
- Do not use todo/checklist tooling to track execution progress; the plan itself belongs in plan_mode_complete.
- Gather information freely: read files, search, inspect configuration, and run read-only commands.

## Asking questions

- Explore first and ask second. Never ask what the repository or system can answer; ask only when multiple plausible choices remain, a needed identifier or context is missing, or the ambiguity is product intent.
- ${askBullet}
- ${declineBullet}
- Bias toward questions over guessing: while a high-impact ambiguity remains, do not produce a plan. For a low-risk unanswered preference, take the recommended option and record it as an explicit assumption in the plan.

## Ending each turn

Every Plan mode turn that advances or finalizes the plan must end in exactly one of these ways:

- ${endingBullet}
- If the implementation plan is decision-complete, call plan_mode_complete alone as your final action. Do not call other tools in the same batch and do not emit a normal assistant response after it.

If a follow-up asks only for clarification and does not change or challenge the plan, answer it directly, then call plan_mode_complete alone as the final action with the complete unchanged plan so it remains available for implementation.

Never end with prose that merely announces you are about to present, write, or finalize the plan. Submit the actual plan with plan_mode_complete in that turn.

## Completion rule

Only call plan_mode_complete when the plan leaves no implementation decisions unresolved. Pass the complete plan as Markdown, structured as the craft document describes:

- A title and a short summary
- The approach, with the alternatives considered and why they lost
- Behavior, interface, and data changes, including the new names and shapes
- Edge cases and failure modes, including what happens to existing state
- Verification: the commands to run and what they should print, plus the manual checks no command covers
- Assumptions and defaults chosen where you decided rather than asked

Keep the plan concise, human and agent digestible, and free of open decisions. Prefer grouped behavior-level changes over file-by-file or symbol-by-symbol inventories. Do not ask "should I proceed?"; plan_mode_complete opens the /plan ready menu.

The plan is saved to a durable file, so it survives compaction and can be re-read at any time.

If the user requests revisions after a completed plan, the next plan_mode_complete call must contain a complete replacement, not a delta. If there is not enough information for a complete replacement, ${revisionClause}.`;
}

/**
 * The plan is never injected into context as a payload. While a plan is active
 * the model gets only this pointer and reads the file on demand, which keeps
 * compaction survival to a single line regardless of plan size.
 */
export function buildActivePlanPointer(planPath: string) {
	return `[APPROVED PLAN] Plan mode is off. The approved implementation plan for this session is stored at ${planPath}. Read that file before implementing, and re-read it if you need the plan again after compaction. The file is the source of truth and the user may have edited it.`;
}
