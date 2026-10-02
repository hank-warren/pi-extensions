import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatTokens } from "./format.js";

/** Status key the child uses to tell the parent its budget ran out. */
export const BUDGET_STATUS_KEY = "pi-agents-budget";

export interface BudgetState {
	turns: number;
	warned: boolean;
	exhausted: boolean;
	/** Tool calls blocked since the budget ran out. */
	blockedCalls: number;
}

export type BudgetAction =
	| { kind: "none" }
	| { kind: "warn"; message: string }
	| { kind: "exhaust"; message: string };

/**
 * Decide what a finished turn means for the budget. Pure, so the thresholds
 * are testable: warn once at 75% of context or 80% of turns, cut tools at
 * 100% of either. Only a turn that will continue (it ran tools) is steered;
 * a final answer is left alone.
 */
export function budgetAfterTurn(
	state: BudgetState,
	input: { tokens: number; continuing: boolean; contextBudget?: number; maxTurns: number },
): BudgetAction {
	state.turns += 1;
	if (!input.continuing || state.exhausted) return { kind: "none" };
	const { tokens, contextBudget, maxTurns } = input;
	// Without a context budget only turns count; the model's own window and
	// Pi's compaction bound the context.
	const contextUsed = contextBudget ? tokens / contextBudget : 0;
	const usage = `${contextBudget ? `${formatTokens(tokens)}/${formatTokens(contextBudget)} tokens, ` : ""}${state.turns}/${maxTurns} turns`;
	if (contextUsed >= 1 || state.turns >= maxTurns) {
		state.exhausted = true;
		return {
			kind: "exhaust",
			message: `[pi-agents] Budget exhausted (${usage}). Tools are now disabled. Write your final report immediately: what you found or changed, what is unfinished, and where to continue.`,
		};
	}
	if (!state.warned && (contextUsed >= 0.75 || state.turns >= Math.floor(maxTurns * 0.8))) {
		state.warned = true;
		return {
			kind: "warn",
			message: `[pi-agents] Budget nearly used (${usage}). Stop exploring. Finish only what is essential, then write your final report.`,
		};
	}
	return { kind: "none" };
}

/**
 * Budget state for a new prompt. Turns start over; the context budget does
 * not: a prompt that starts at or over it starts exhausted, with tools
 * refused from the first call. Pure, for tests.
 */
export function budgetAtPromptStart(
	state: BudgetState,
	input: { tokens: number; contextBudget?: number },
): { kind: "none" } | { kind: "exhaust"; message: string } {
	const { tokens, contextBudget } = input;
	state.turns = 0;
	state.blockedCalls = 0;
	if (contextBudget && tokens >= contextBudget) {
		state.exhausted = true;
		state.warned = true;
		return {
			kind: "exhaust",
			message: `[pi-agents] Context budget already used (${formatTokens(tokens)}/${formatTokens(contextBudget)} tokens). Tools are disabled. Answer from what you already know, and say what would need a fresh agent.`,
		};
	}
	state.exhausted = false;
	state.warned = contextBudget ? tokens >= contextBudget * 0.75 : false;
	return { kind: "none" };
}

function envInt(name: string): number | undefined {
	const value = Number(process.env[name]);
	return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Runs inside a child process (`PI_AGENTS_CHILD=1`). Registers no tools, so a
 * child can never spawn agents; only enforces the context and turn budget.
 */
export function registerChild(pi: ExtensionAPI): void {
	const contextBudget = envInt("PI_AGENTS_CONTEXT_BUDGET");
	const maxTurns = envInt("PI_AGENTS_MAX_TURNS") ?? 80;
	const state: BudgetState = { turns: 0, warned: false, exhausted: false, blockedCalls: 0 };

	// before_agent_start fires once per prompt (a new task or follow-up), never
	// for Pi's own continuations such as automatic retries, so a retry cannot
	// hand out a fresh budget.
	pi.on("before_agent_start", (_event, ctx) => {
		const start = budgetAtPromptStart(state, { tokens: ctx.getContextUsage()?.tokens ?? 0, contextBudget });
		ctx.ui.setStatus(BUDGET_STATUS_KEY, state.exhausted ? "exhausted" : undefined);
		if (start.kind !== "exhaust") return;
		return { message: { customType: "pi-agents-budget", content: start.message, display: true } };
	});

	pi.on("turn_end", (event, ctx) => {
		const action = budgetAfterTurn(state, {
			tokens: ctx.getContextUsage()?.tokens ?? 0,
			continuing: event.toolResults.length > 0,
			contextBudget,
			maxTurns,
		});
		if (action.kind === "none") return;
		if (action.kind === "exhaust") ctx.ui.setStatus(BUDGET_STATUS_KEY, "exhausted");
		pi.sendUserMessage(action.message, { deliverAs: "steer" });
	});

	// Tools stay declared (some providers reject a transcript with tool calls
	// but no tools), but every call is refused once the budget is gone. A model
	// that keeps calling anyway is aborted, so the run always ends.
	pi.on("tool_call", (_event, ctx) => {
		if (!state.exhausted) return;
		state.blockedCalls += 1;
		if (state.blockedCalls > 3) ctx.abort();
		return { block: true, reason: "Budget exhausted: tools are disabled. Write your final report now, without tool calls." };
	});
}
