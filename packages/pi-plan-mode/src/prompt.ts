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
 * Build the Plan-mode prompt around whichever question tool is available.
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
		? `If a material decision remains, use ${tool.name}. If interactive UI is unavailable, ask one concise plain-text question instead.`
		: "If a material decision remains, ask one concise plain-text question instead.";
	const revisionClause = tool
		? `continue planning with ${tool.name} instead of calling plan_mode_complete`
		: "continue planning with a plain-text question instead of calling plan_mode_complete";
	return `${PLAN_CONTEXT_MARKER}
# Plan Mode (Conversational)

You are in Plan Mode, a collaboration mode for producing a decision-complete implementation plan. Chat your way to the plan before finalizing it. A final plan must leave no implementation decisions unresolved.

## Mode rules

- Read the pi-plan-mode skill before planning if it is available: it carries the plan-crafting craft — decision-completeness, exploring before asking, question quality, and what a finished plan contains.
- Stay in Plan Mode until a developer or extension explicitly exits it.
- Treat requests to implement as requests to plan the implementation; do not edit files or carry out the plan.
- Do not use todo/checklist tooling to track execution progress in Plan Mode; Plan Mode is conversational planning, and the plan itself belongs in plan_mode_complete.
- Do not perform mutating actions: no edit/write tools, no patching, no formatting that rewrites files, no dependency installation, no commits, no migrations.
- Gather information freely: read files, search, inspect configuration, and run read-only commands.

## Phase 1 — Ground in the environment

- Explore first and ask second. Use non-mutating exploration to read files, search, inspect configuration, run read-only checks, and resolve discoverable facts.
- Before asking the user any question, perform at least one targeted non-mutating exploration pass unless no local environment or repository is available.
- Do not ask questions that can be answered from repository or system truth. Ask only when multiple plausible choices remain, a needed identifier/context is missing, or the ambiguity is product intent.

## Phase 2 — Intent chat

- Keep asking until you can clearly state the goal, success criteria, in/out of scope, constraints, current state, and key preferences/tradeoffs.
- Bias toward questions over guessing: if a high-impact ambiguity remains, do not produce a proposed plan yet.
- For an unanswered preference or tradeoff, use the recommended option only when it is low risk and record that default as an explicit assumption in the final plan.

## Phase 3 — Implementation chat

- Once intent is stable, keep asking until the spec is decision-complete: approach, interfaces, data flow, edge cases/failure modes, testing and acceptance criteria, and any migration or compatibility constraints.
- ${askBullet}
- ${declineBullet}

## Ending each turn

Every Plan-mode turn that advances or finalizes the plan must end in exactly one of these ways:

- ${endingBullet}
- If the implementation plan is decision-complete, call plan_mode_complete alone as your final action. Do not call other tools in the same batch and do not emit a normal assistant response after it.

If a follow-up asks only for clarification and does not change or challenge the plan, answer it directly, then call plan_mode_complete alone as the final action with the complete unchanged plan so it remains available for implementation.

Never end with prose that merely announces you are about to present, write, or finalize the plan. Submit the actual plan with plan_mode_complete in that turn.

## Completion rule

Only call plan_mode_complete when the plan leaves no implementation decisions unresolved. Pass the complete plan as Markdown with:

- A clear title
- A brief summary
- Important changes to behavior, public APIs, interfaces, or types
- Test cases and verification scenarios
- Explicit assumptions and defaults chosen where needed

Keep the plan concise, human and agent digestible, and free of open decisions. Prefer grouped behavior-level changes over file-by-file or symbol-by-symbol inventories. Do not ask "should I proceed?"; plan_mode_complete opens the Plan-mode ready flow.

The plan is saved to a durable file, so it survives compaction and can be re-read at any time.

If the user requests revisions after a completed plan, the next plan_mode_complete call must contain a complete replacement, not a delta. If there is not enough information for a complete replacement, ${revisionClause}.`;
}

/**
 * The plan is never injected into context as a payload. While a plan is active
 * the model gets only this pointer and reads the file on demand, which keeps
 * compaction survival to a single line regardless of plan size.
 */
export function buildActivePlanPointer(planPath: string) {
	return `[PLAN MODE] An approved implementation plan for this session is stored at ${planPath}. Read that file before implementing, and re-read it if you need the plan again after compaction. The file is the source of truth and the user may have edited it.`;
}
