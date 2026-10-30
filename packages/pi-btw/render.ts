import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Usage } from "./ask.ts";

export const ENTRY_TYPE = "pi-btw";
/** Lines of a streaming answer kept in the widget; the transcript card shows all of it. */
const LIVE_LINES = 12;
/** Pi indents chat messages by one column; the card and widget line up with them. */
const PAD = 1;

/** A finished side question, stored as a display-only session entry. */
export interface BtwEntry {
	question: string;
	answer: string;
	model: string;
	toolCalls?: string[];
	truncated?: boolean;
	usage?: Usage;
	durationMs?: number;
}

export interface LiveState {
	question: string;
	answer: string;
	thinking: boolean;
}

function yellow(theme: Theme) {
	return { color: (text: string) => theme.fg("warning", text) };
}

function heading(theme: Theme, question: string): string {
	return `${theme.fg("warning", theme.bold("btw"))} ${theme.fg("muted", question)}`;
}

/** The streaming answer, above the editor until it finishes. */
export class LiveWidget implements Component {
	private readonly markdown: Markdown;
	private shownAnswer = "";

	constructor(private readonly theme: Theme, private readonly state: LiveState) {
		this.markdown = new Markdown("", PAD, 0, getMarkdownTheme(), yellow(theme));
	}

	render(width: number): string[] {
		const { theme, state } = this;
		// The TUI re-renders on every spinner frame; re-parse only when the answer grew.
		if (state.answer !== this.shownAnswer) {
			this.shownAnswer = state.answer;
			this.markdown.setText(state.answer);
		}
		const body = state.answer ? this.markdown.render(width) : [];
		const shown = body.slice(-LIVE_LINES);
		const phase = state.answer ? "answering" : state.thinking ? "thinking" : "asking";
		return [
			truncateToWidth(` ${heading(theme, state.question)}`, width),
			...(body.length > shown.length ? [` ${theme.fg("dim", "…")}`] : []),
			...shown,
			truncateToWidth(` ${theme.fg("dim", `${phase}… · /btw alone cancels`)}`, width),
		];
	}

	invalidate(): void {
		this.markdown.invalidate();
	}
}

/** The transcript card: question, answer in yellow, and what the cache did. */
export function renderEntry(data: unknown, theme: Theme): Component {
	const entry = asEntry(data);
	if (!entry) return new Text(theme.fg("warning", "btw (unreadable entry)"), PAD, 0);
	const card = new Container();
	card.addChild(new Text(heading(theme, entry.question), PAD, 0));
	card.addChild(new Markdown(entry.answer || "(no answer)", PAD, 0, getMarkdownTheme(), yellow(theme)));
	const notes = [
		...(entry.truncated ? ["answer cut off at the output limit"] : []),
		...(entry.toolCalls?.length ? [`tried to call ${entry.toolCalls.join(", ")}; /btw cannot run tools`] : []),
	];
	for (const note of notes) card.addChild(new Text(theme.fg("dim", note), PAD, 0));
	card.addChild(new Text(theme.fg("dim", formatStats(entry)), PAD, 0));
	return card;
}

/** `cpa/claude · 98% cached of 41.2k · 312 out · 3.4s`: the cached share is the point of /btw. */
export function formatStats(entry: Pick<BtwEntry, "model" | "usage" | "durationMs">): string {
	const parts = [entry.model];
	const usage = entry.usage;
	if (usage) {
		const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
		if (prompt > 0) parts.push(`${Math.floor((usage.cacheRead / prompt) * 100)}% cached of ${tokens(prompt)}`);
		parts.push(`${tokens(usage.output)} out`);
	}
	if (entry.durationMs !== undefined) parts.push(`${(entry.durationMs / 1000).toFixed(1)}s`);
	return parts.join(" · ");
}

function tokens(count: number): string {
	if (count < 1000) return String(count);
	return count < 100_000 ? `${(count / 1000).toFixed(1)}k` : `${Math.round(count / 1000)}k`;
}

function asEntry(data: unknown): BtwEntry | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const entry = data as Partial<BtwEntry>;
	return typeof entry.question === "string" && typeof entry.answer === "string" && typeof entry.model === "string"
		? (entry as BtwEntry)
		: undefined;
}
