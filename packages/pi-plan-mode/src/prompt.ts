import { join } from "node:path";
import { UPDATE_PLAN_TOOL_NAME } from "./update-plan-tool.js";

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
 * What the model is told while a revision of an existing plan is open.
 *
 * The revision variant is the same document with one thing changed: the turn
 * ends in `update_plan(action:"propose")` instead of `plan_mode_complete`. Every
 * other rule — no mutation, explore before asking, a complete plan rather than a
 * delta — applies identically, which is why this is a parameter rather than a
 * second prompt that would drift from the first.
 */
export interface PlanRevisionPromptContext {
	planPath: string;
	revisionId: string;
	baseRevision: number;
	/** What the user asked for, in their own terms. */
	instructions: string;
	/** Set when the plan file does not match its recorded revision. */
	conflict?: string;
}

/**
 * What the model is told while Plan mode is on over a plan that **already
 * exists** and has managed history, with no revision open yet.
 *
 * That is the state an accepted or cancelled revision leaves behind, and the
 * state a ready managed plan sits in. `plan_mode_complete` is refused there, so a
 * prompt that still ended every turn in it would send the model at a refusal and
 * leave the user's "tweak X" unanswered. This variant ends the turn in
 * `update_plan(action:"begin")` instead — the same route the tool description and
 * the active-plan context line name.
 */
export interface ManagedPlanPromptContext {
	planPath: string;
	/** The managed spec revision the next `begin` must quote back. */
	specRevision: number;
}

/**
 * Which plan the prompt is about, when it is not a first draft.
 *
 * Omitted for initial drafting, which is the state `plan_mode_complete` exists
 * for and the one whose wording must not move.
 */
export type PlanModePromptContext =
	| ({ kind: "revision" } & PlanRevisionPromptContext)
	| ({ kind: "managed" } & ManagedPlanPromptContext);

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
export function buildPlanModePrompt(
	questionTool: string | null = PLAN_MODE_QUESTION_TOOL,
	context?: PlanModePromptContext,
) {
	const revision = context?.kind === "revision" ? context : undefined;
	const managed = context?.kind === "managed" ? context : undefined;
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
	const beginCall = managed
		? `update_plan with action "begin" and expectedRevision ${managed.specRevision}`
		: "";
	const finalCall = revision
		? `update_plan with action "propose", revisionId "${revision.revisionId}" and expectedRevision ${revision.baseRevision}`
		: managed
			? beginCall
			: "plan_mode_complete";
	const revisionClause = tool
		? `continue planning with ${tool.name} instead of calling ${finalCall}`
		: `continue planning with a plain-text question instead of calling ${finalCall}`;
	const intro = revision
		? `You are revising an implementation plan that already exists, under the same rules that produced it: the result must be decision-complete, and you must not start carrying it out.

## This revision

- The current plan is stored at ${revision.planPath}. Read it first; it is the plan you are changing, not a draft to replace from memory.
- The user asked for: ${revision.instructions}
- Change what they asked for and deliberately keep the rest. Say which is which in changeSummary; the user reviews a computed diff beside it.${
				revision.conflict ? `\n- Note: ${revision.conflict} Reconcile it in the revision rather than ignoring it.` : ""
			}
- Finish the revision by calling ${finalCall} with the complete rewritten plan. Do not call plan_mode_complete; it is for a first draft and will refuse while this revision is open.`
		: managed
			? `You are in Plan mode over a plan that already exists and has been agreed with the user, at ${managed.planPath} (spec revision ${managed.specRevision}).

## This plan already exists

- Read ${managed.planPath} before saying anything about the plan. It is the agreed plan, not a draft to replace from memory.
- Changing it is a reviewed revision, not a rewrite: call ${beginCall}, then action "propose" with the complete rewritten plan. The user accepts, asks for changes, or cancels.
- Do not call plan_mode_complete. It is refused for a plan that already exists, because it carries no base revision and no digest, so nothing could check what the change was against.
- If the user only wants to talk about the plan, answer them. Open a revision when they ask for the plan itself to change.`
			: "You are in Plan mode, a collaboration mode for producing a decision-complete implementation plan: one a competent implementer could execute without asking anything further. Chat your way to the plan before finalizing it.";
	const checklistBullet =
		revision || managed
			? "- Do not use todo/checklist tooling to track execution progress; the plan itself belongs in the revision you propose."
			: "- Do not use todo/checklist tooling to track execution progress; the plan itself belongs in plan_mode_complete.";
	const completionHeading = revision
		? `Only call ${finalCall} when the revised plan leaves no implementation decisions unresolved. Pass the complete plan as Markdown, structured as the craft document describes:`
		: managed
			? `A change to this plan is proposed, never submitted outright. Open it with ${beginCall}, then propose the complete rewritten plan as Markdown, structured as the craft document describes:`
			: "Only call plan_mode_complete when the plan leaves no implementation decisions unresolved. Pass the complete plan as Markdown, structured as the craft document describes:";
	const completionTail = revision
		? `Keep the plan concise, human and agent digestible, and free of open decisions. Prefer grouped behavior-level changes over file-by-file or symbol-by-symbol inventories. Do not ask "should I proceed?"; proposing the revision opens the review card the user decides on.

The plan is saved to a durable file, so it survives compaction and can be re-read at any time.

Every proposal is a complete replacement, never a delta. If the user asks for further changes after you propose, call ${finalCall} again with the complete corrected plan. If there is not enough information for a complete replacement, ${revisionClause}.`
		: managed
			? `Keep the plan concise, human and agent digestible, and free of open decisions. Prefer grouped behavior-level changes over file-by-file or symbol-by-symbol inventories. Do not ask "should I proceed?"; proposing a revision opens the review card the user decides on.

The plan is saved to a durable file, so it survives compaction and can be re-read at any time.

Every proposal is a complete replacement, never a delta. If there is not enough information for a complete replacement, ${revisionClause}.`
			: `Keep the plan concise, human and agent digestible, and free of open decisions. Prefer grouped behavior-level changes over file-by-file or symbol-by-symbol inventories. Do not ask "should I proceed?"; plan_mode_complete opens the /plan ready menu.

The plan is saved to a durable file, so it survives compaction and can be re-read at any time.

If the user requests revisions after a completed plan, the next plan_mode_complete call must contain a complete replacement, not a delta. If there is not enough information for a complete replacement, ${revisionClause}.`;
	const endingFinalBullet = revision
		? `- If the revised plan is decision-complete, call ${finalCall} alone as your final action. Do not call other tools in the same batch and do not emit a normal assistant response after it.`
		: managed
			? `- If the user asked for the plan to change, call ${beginCall} and carry on in the same turn; finish that revision with action "propose" alone as your final action.`
			: "- If the implementation plan is decision-complete, call plan_mode_complete alone as your final action. Do not call other tools in the same batch and do not emit a normal assistant response after it.";
	const clarificationParagraph = revision
		? `If a follow-up asks only for clarification and does not change or challenge the revision, answer it directly, then call ${finalCall} alone as the final action with the complete plan so the revision remains available for review.`
		: managed
			? "If a follow-up asks only for clarification and does not change or challenge the plan, answer it directly and open no revision. The agreed plan stays exactly as it is."
			: "If a follow-up asks only for clarification and does not change or challenge the plan, answer it directly, then call plan_mode_complete alone as the final action with the complete unchanged plan so it remains available for implementation.";
	const announceParagraph = revision
		? `Never end with prose that merely announces you are about to present, write, or finalize the plan. Submit the actual plan with ${finalCall} in that turn.`
		: managed
			? `Never end with prose that merely announces you are about to revise the plan. Open the revision with ${beginCall} in that turn.`
			: "Never end with prose that merely announces you are about to present, write, or finalize the plan. Submit the actual plan with plan_mode_complete in that turn.";
	return `${PLAN_CONTEXT_MARKER}
# Plan mode

${intro}

## Mode rules

- Before planning, read ${PLAN_CRAFT_DOC}. It carries the craft this prompt does not repeat: what decision-complete means, why exploration comes before questions, what separates a question worth asking from one the repository already answers, and what a finished plan contains.
- Stay in Plan mode until a developer or extension explicitly exits it.
- Treat requests to implement as requests to plan the implementation; do not edit files or carry out the plan.
- Do not perform mutating actions: no edit/write tools, no patching, no formatting that rewrites files, no dependency installation, no commits, no migrations.
${checklistBullet}
- Gather information freely: read files, search, inspect configuration, and run read-only commands.

## Asking questions

- Explore first and ask second. Never ask what the repository or system can answer; ask only when multiple plausible choices remain, a needed identifier or context is missing, or the ambiguity is product intent.
- ${askBullet}
- ${declineBullet}
- Bias toward questions over guessing: while a high-impact ambiguity remains, do not produce a plan. For a low-risk unanswered preference, take the recommended option and record it as an explicit assumption in the plan.

## Ending each turn

Every Plan mode turn that advances or finalizes the plan must end in exactly one of these ways:

- ${endingBullet}
${endingFinalBullet}

${clarificationParagraph}

${announceParagraph}

## Completion rule

${completionHeading}

- A title and a short summary
- The approach, with the alternatives considered and why they lost
- Behavior, interface, and data changes, including the new names and shapes
- Edge cases and failure modes, including what happens to existing state
- Verification: the commands to run and what they should print, plus the manual checks no command covers
- Assumptions and defaults chosen where you decided rather than asked

${completionTail}`;
}

/**
 * What an active plan costs the model per turn, and how it is changed.
 *
 * The plan is never injected into context as a payload. While a plan is active
 * the model gets only this pointer and reads the file on demand, which keeps
 * compaction survival to a single line regardless of plan size.
 *
 * The revision sentence is part of the pointer rather than only of the tool
 * description for one reason: a model asked to change the plan reaches for
 * whichever instruction is loudest, and "edit the file" is the loudest
 * instruction in any coding agent's prompt. Naming `update_plan` here, beside
 * the path, is what makes the tool the obvious move instead of `edit`.
 */
export function buildActivePlanPointer(
	planPath: string,
	detail: {
		/** The managed spec revision, or 0 when the plan has no history yet. */
		revision?: number;
		/** Set when approval is unknown or no longer covers the file on disk. */
		approvalNotice?: string;
		/**
		 * How a person can get back to a known-approved plan *in this session's mode*,
		 * from `approvalRecoveryInstruction`. Passed in rather than written here so the
		 * model, the menu and every refusal quote one sentence, and so a headless run
		 * is never sent at the interactive menu.
		 */
		recoveryInstruction?: string;
	} = {},
) {
	const revision = detail.revision ?? 0;
	const lines = [
		`[APPROVED PLAN] Plan mode is off. The approved implementation plan for this session is stored at ${planPath}. Read that file before implementing, and re-read it if you need the plan again after compaction. The file is the source of truth and the user may have edited it.`,
		`The plan is at spec revision ${revision}. To change it — any addition, removal, re-sequencing, or change of approach the user asks for — call ${UPDATE_PLAN_TOOL_NAME} with action "begin" and expectedRevision ${revision}, then action "propose" with the complete rewritten plan. Never edit this file with edit or write, and never tell the user to edit it or to run a command.`,
	];
	if (detail.approvalNotice) {
		lines.push(
			detail.recoveryInstruction
				? `${detail.approvalNotice} Do not mark the plan implemented in this state, and do not treat it as approved on your own — ${detail.recoveryInstruction}`
				: `${detail.approvalNotice} Do not mark the plan implemented in this state, and do not treat it as approved on your own.`,
		);
	}
	return lines.join("\n");
}
