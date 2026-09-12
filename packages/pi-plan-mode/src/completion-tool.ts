import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

import { TASK_SEED_SCHEMA, parseTaskSeed, type TaskSeed } from "./plan-contract.js";

export const PLAN_MODE_COMPLETE_TOOL_NAME = "plan_mode_complete";
const PLAN_MODE_COMPLETE_VERSION = 1;
const PLAN_MODE_MAX_CHARS = 50_000;

type PlanModeCompletionDetails = {
	version: typeof PLAN_MODE_COMPLETE_VERSION;
	source: typeof PLAN_MODE_COMPLETE_TOOL_NAME;
	plan: string;
	planPath?: string;
};

export const PLAN_MODE_COMPLETE_PARAMS = {
	type: "object",
	additionalProperties: false,
	required: ["plan"],
	properties: {
		tasks: TASK_SEED_SCHEMA,
		plan: {
			type: "string",
			minLength: 1,
			maxLength: PLAN_MODE_MAX_CHARS,
			description: "The complete decision-ready implementation plan in Markdown.",
		},
	},
} as const;

type NormalizePlanModeCompletionResult = { ok: true; plan: string; tasks?: TaskSeed } | { ok: false; error: string };

export function normalizePlanModeCompletion(input: unknown): NormalizePlanModeCompletionResult {
	if (!isRecord(input) || typeof input.plan !== "string") {
		return { ok: false, error: "plan must be a string" };
	}
	const plan = input.plan.trim();
	if (!plan) return { ok: false, error: "plan must not be empty" };
	if (plan.length > PLAN_MODE_MAX_CHARS) {
		return {
			ok: false,
			error: `plan must not exceed ${PLAN_MODE_MAX_CHARS} characters`,
		};
	}
	try { return { ok: true, plan, ...(input.tasks !== undefined ? { tasks: parseTaskSeed(input.tasks) } : {}) }; }
	catch (error) { return { ok: false, error: String(error) }; }
}

function planFromCompletionDetails(value: unknown) {
	if (!isRecord(value)) return undefined;
	if (
		value.version !== PLAN_MODE_COMPLETE_VERSION ||
		value.source !== PLAN_MODE_COMPLETE_TOOL_NAME
	) {
		return undefined;
	}
	const normalized = normalizePlanModeCompletion({ plan: value.plan });
	return normalized.ok ? normalized.plan : undefined;
}

export function planModeCompleted(plan: string, planPath?: string, tasks?: TaskSeed) {
	return {
		content: [
			{
				type: "text" as const,
				text: (planPath ? `Plan saved to ${planPath}.` : "Plan saved.") + (tasks ? `\n\nTask scope for your implementation decision:\n${tasks.phases.map((p) => `## ${p.name}\n${p.tasks.map((t) => `- ${t.content}`).join("\n")}`).join("\n")}` : ""),
			},
		],
		details: {
			version: PLAN_MODE_COMPLETE_VERSION,
			source: PLAN_MODE_COMPLETE_TOOL_NAME,
			plan,
			...(planPath ? { planPath } : {}),
		} satisfies PlanModeCompletionDetails,
		terminate: true,
	};
}

type PlanModeCompletionRenderResult = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
};

function planModeCompletionMarkdown(result: PlanModeCompletionRenderResult) {
	const content = result.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (content) return content;
	const plan = planFromCompletionDetails(result.details);
	return plan ? `**Proposed Plan**\n\n${plan}` : "";
}

export function renderPlanModeCompletion(result: PlanModeCompletionRenderResult) {
	return new Markdown(planModeCompletionMarkdown(result), 0, 0, getMarkdownTheme());
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
