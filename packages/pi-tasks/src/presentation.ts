/**
 * One formatter, two surfaces.
 *
 * The footer line and the widget above the editor say the same thing in two
 * sizes, so they are computed once. When each formatted its own they drifted:
 * pi-loop shipped a loop that read as "waiting" in the footer and "running"
 * above the editor, and pi-plan-mode's `presentation.ts` carries the same note
 * for the same reason. The glyph family is shared by convention, not by import:
 * `◆` wants a decision, `▶` is work in flight, `☰` is a task list at rest.
 *
 * Cards are durable session entries rather than messages. Pi maps a `custom`
 * entry to no context messages at all, so a full task document or a proposal
 * diff can sit in the transcript, survive compaction, and cost the model
 * nothing.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import {
	countTasks,
	inProgressTask,
	type TaskSet,
	type TaskStatus,
} from "./model.js";

const STATUS_KEY = "pi-tasks";
const WIDGET_KEY = "pi-tasks";
export const TASKS_CARD_ENTRY_TYPE = "pi-tasks-card";

/** Longest task title the one-line surfaces will show before eliding. */
const MAX_INLINE_CONTENT = 48;

const STATUS_LABELS: Record<TaskStatus, string> = {
	pending: "pending",
	in_progress: "in progress",
	blocked: "blocked",
	completed: "completed",
	abandoned: "abandoned",
};

const STATUS_MARKS: Record<TaskStatus, string> = {
	pending: " ",
	in_progress: "/",
	blocked: "!",
	completed: "x",
	abandoned: "-",
};

export interface TasksUiState {
	set?: TaskSet;
	/** A pending proposal is waiting for the user to accept, revise, or cancel. */
	pendingReview: boolean;
	/** Mutation is refused until recovery resolves a conflict. */
	blocked?: string;
}

export interface TasksView {
	phase: "review" | "blocked" | "working" | "tracking" | "done";
	footer: string;
	headline: string;
	hint: string;
	tone: "accent" | "normal";
}

export function tasksView(state: TasksUiState): TasksView | undefined {
	if (state.blocked) {
		return {
			phase: "blocked",
			footer: "◆ tasks · needs recovery",
			headline: "◆ tasks · needs recovery",
			hint: "The task document diverged from this session. Run /tasks recover.",
			tone: "accent",
		};
	}
	if (!state.set) return undefined;
	const counts = countTasks(state.set);
	const active = inProgressTask(state.set);
	const progress = `${counts.completed}/${counts.total} done`;
	if (state.pendingReview) {
		return {
			phase: "review",
			footer: `◆ tasks · revision awaiting review · ${progress}`,
			headline: "◆ tasks · proposed revision awaiting review",
			hint: "Accept, request changes, or cancel — /tasks review reopens it.",
			tone: "accent",
		};
	}
	if (active) {
		const content = elide(active.task.content, MAX_INLINE_CONTENT);
		return {
			phase: "working",
			footer: `▶ tasks · ${progress} · ${content}`,
			headline: `▶ tasks · ${progress}`,
			hint: `In progress: ${content}`,
			tone: "normal",
		};
	}
	if (counts.total > 0 && counts.open === 0) {
		return {
			phase: "done",
			footer: `☰ tasks · ${progress} · all closed`,
			headline: `☰ tasks · ${progress}`,
			hint: "Every task is closed. /tasks archive files the set away.",
			tone: "normal",
		};
	}
	const blockedSuffix = counts.blocked > 0 ? ` · ${counts.blocked} blocked` : "";
	return {
		phase: "tracking",
		footer: `☰ tasks · ${progress}${blockedSuffix}`,
		headline: `☰ tasks · ${progress}${blockedSuffix}`,
		hint: "/tasks shows the list; the agent updates it with update_tasks.",
		tone: "normal",
	};
}

interface WidgetTheme {
	bold?: (text: string) => string;
	fg?: (color: string, text: string) => string;
}

type WidgetFactory = Parameters<ExtensionContext["ui"]["setWidget"]>[1];

export function updateTasksUi(ctx: ExtensionContext, state: TasksUiState): void {
	const view = tasksView(state);
	ctx.ui.setStatus(STATUS_KEY, view?.footer);
	if (!view) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	try {
		const render = (_tui: unknown, rawTheme: unknown) => {
			const theme = (rawTheme ?? {}) as WidgetTheme;
			const bold = theme.bold ?? ((text: string) => text);
			const headline =
				view.tone === "accent"
					? (theme.fg?.("accent", bold(view.headline)) ?? bold(view.headline))
					: bold(view.headline);
			const hint = theme.fg?.("dim", `  ${view.hint}`) ?? `  ${view.hint}`;
			return new Text(`${headline}\n${hint}`);
		};
		ctx.ui.setWidget(WIDGET_KEY, render as WidgetFactory);
	} catch {
		// Presentation only: a host without the component form of setWidget must
		// never take a task mutation down with it.
	}
}

export function clearTasksUi(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

interface TasksCardData {
	title: string;
	body: string;
}

function tasksCardData(value: unknown): TasksCardData | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { title, body } = value as { title?: unknown; body?: unknown };
	return typeof title === "string" && typeof body === "string"
		? { title, body }
		: undefined;
}

export function registerTasksCardRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(TASKS_CARD_ENTRY_TYPE, (entry) => {
		const data = tasksCardData(entry.data);
		if (!data) return new Text("Task card unavailable.", 0, 0);
		return new Markdown(`**${data.title}**\n\n${data.body}`, 0, 0, getMarkdownTheme());
	});
}

export function showTasksCard(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	title: string,
	body: string,
): void {
	try {
		pi.appendEntry<TasksCardData>(TASKS_CARD_ENTRY_TYPE, { title, body });
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Unable to show the task card: ${detail}`, "error");
	}
}

/** The set as Markdown, for cards, `/tasks show`, and export. */
export function formatTaskSetMarkdown(set: TaskSet): string {
	const counts = countTasks(set);
	const lines: string[] = [];
	lines.push(
		`Revision ${set.revision} · ${counts.completed}/${counts.total} done · ${counts.open} open${set.archivedAt ? " · archived" : ""}`,
	);
	for (const phase of set.phases) {
		lines.push("");
		lines.push(`**${phase.name}** (${phase.id})`);
		if (phase.tasks.length === 0) {
			lines.push("- _(no tasks)_");
			continue;
		}
		for (const task of phase.tasks) {
			const suffix =
				task.status === "blocked" && task.blocker
					? ` — blocked: ${task.blocker}`
					: task.completion
						? ` — ${STATUS_LABELS[task.status]}: ${task.completion.summary}`
						: "";
			lines.push(`- [${STATUS_MARKS[task.status]}] \`${task.id}\` ${task.content}${suffix}`);
		}
	}
	return lines.join("\n");
}

/** The one-line status sentence, for notifications and non-TUI modes. */
export function tasksStatusText(state: TasksUiState): string {
	if (state.blocked) return `Tasks need recovery: ${state.blocked}`;
	if (!state.set) return "No task set is attached to this session.";
	const counts = countTasks(state.set);
	const active = inProgressTask(state.set);
	const parts = [
		`Task set ${state.set.taskSetId} at revision ${state.set.revision}`,
		`${counts.completed}/${counts.total} done`,
		`${counts.open} open`,
	];
	if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
	if (counts.abandoned > 0) parts.push(`${counts.abandoned} abandoned`);
	if (active) parts.push(`in progress: ${active.task.content}`);
	if (state.pendingReview) parts.push("a proposed revision is awaiting review");
	return `${parts.join(" · ")}.`;
}

function elide(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
