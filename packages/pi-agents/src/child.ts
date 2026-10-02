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
	input: { tokens: number; continuing: boolean; contextBudget: number; maxTurns: number },
): BudgetAction {
	state.turns += 1;
	if (!input.continuing || state.exhausted) return { kind: "none" };
	const { tokens, contextBudget, maxTurns } = input;
	const usage = `${formatTokens(tokens)}/${formatTokens(contextBudget)} tokens, ${state.turns}/${maxTurns} turns`;
	if (tokens >= contextBudget || state.turns >= maxTurns) {
		state.exhausted = true;
		return {
			kind: "exhaust",
			message: `[pi-agents] Budget exhausted (${usage}). Tools are now disabled. Write your final report immediately: what you found or changed, what is unfinished, and where to continue.`,
		};
	}
	if (!state.warned && (tokens >= contextBudget * 0.75 || state.turns >= Math.floor(maxTurns * 0.8))) {
		state.warned = true;
		return {
			kind: "warn",
			message: `[pi-agents] Budget nearly used (${usage}). Stop exploring. Finish only what is essential, then write your final report.`,
		};
	}
	return { kind: "none" };
}

function envInt(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Runs inside a child process (`PI_AGENTS_CHILD=1`). Registers no tools, so a
 * child can never spawn agents; only enforces the context and turn budget.
 */
export function registerChild(pi: ExtensionAPI): void {
	const contextBudget = envInt("PI_AGENTS_CONTEXT_BUDGET", 200_000);
	const maxTurns = envInt("PI_AGENTS_MAX_TURNS", 80);
	const state: BudgetState = { turns: 0, warned: false, exhausted: false, blockedCalls: 0 };

	pi.on("agent_start", (_event, ctx) => {
		state.turns = 0;
		state.blockedCalls = 0;
		const tokens = ctx.getContextUsage()?.tokens ?? 0;
		// A follow-up prompt gets a fresh turn budget; the context budget only
		// resets if the context itself is back under it (e.g. after compaction).
		if (tokens < contextBudget) {
			if (state.exhausted) ctx.ui.setStatus(BUDGET_STATUS_KEY, undefined);
			state.exhausted = false;
			state.warned = tokens >= contextBudget * 0.75;
		}
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
