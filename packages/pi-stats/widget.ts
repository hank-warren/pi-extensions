import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	totalTokens,
	type ModelStats,
	type ProjectStats,
	type StatsRange,
	type StatsSnapshot,
	type ToolStats,
	type UsageTotals,
} from "./types.ts";

type WidgetState =
	| { kind: "loading"; completed: number; total: number }
	| { kind: "error"; message: string }
	| { kind: "ready"; snapshot: StatsSnapshot };

interface StatsWidgetOptions {
	theme: Theme;
	requestRender: () => void;
	onClose: () => void;
	onRefresh: () => void;
	getSnapshot: (range: StatsRange) => StatsSnapshot | undefined;
	onDispose?: () => void;
}

const MAX_ROWS = 24;
/** Top border, tab row, headline, hint row, bottom border. */
const CHROME_ROWS = 5;
const MAX_MODEL_PAGE = 10;
const MIN_MODEL_PAGE = 1;
const HEATMAP_ROWS = 9;
const HEATMAP_MIN_WEEKS = 12;
const HEATMAP_MAX_WEEKS = 53;
const HEATMAP_LABEL_WIDTH = 6;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RANGES: StatsRange[] = ["all", "7d", "30d"];
const RANGE_LABELS: Record<StatsRange, string> = { all: "All time", "7d": "Last 7 days", "30d": "Last 30 days" };

type StatsTab = "overview" | "models" | "tools" | "projects";
const TABS: StatsTab[] = ["overview", "models", "tools", "projects"];
const TAB_LABELS: Record<StatsTab, string> = { overview: "Overview", models: "Models", tools: "Tools", projects: "Projects" };

export function formatTokens(value: number, exact = false): string {
	const safe = Math.max(0, Math.round(value));
	if (exact) return safe.toLocaleString("en-US");
	if (safe >= 1_000_000_000) return `${(safe / 1_000_000_000).toFixed(1)}B`;
	if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
	if (safe >= 1_000) return `${(safe / 1_000).toFixed(safe < 10_000 ? 1 : 0)}K`;
	return String(safe);
}

export function formatCost(value: number): string {
	const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
	return `$${safe.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDuration(milliseconds: number): string {
	if (milliseconds <= 0) return "0m";
	const minutes = Math.floor(milliseconds / 60_000);
	const days = Math.floor(minutes / 1_440);
	const hours = Math.floor((minutes % 1_440) / 60);
	const mins = minutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${mins}m`;
	return `${mins}m`;
}

function cacheHit(usage: UsageTotals): string {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	return prompt > 0 ? `${((usage.cacheRead / prompt) * 100).toFixed(1)}%` : "—";
}

function localDay(time: number): string {
	const date = new Date(time);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function padRight(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(0, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function padLeft(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(0, width), "");
	return " ".repeat(Math.max(0, width - visibleWidth(clipped))) + clipped;
}

interface TableColumn {
	header: string;
	cells: string[];
	align: "left" | "right";
	/** 0 never drops; higher numbers are dropped first when the table does not fit. */
	drop: number;
	/** Short label used when the column moves to a continuation line. */
	label?: string;
	/** Decoration that simply disappears instead of moving to a continuation line. */
	decorative?: true;
}

interface TableLayout {
	header: string;
	rows: string[];
	extras: string[][];
	width: number;
}

function wrap(pieces: readonly string[], width: number, indent: string): string[] {
	const lines: string[] = [];
	let current = "";
	for (const piece of pieces) {
		const candidate = current.length > 0 ? `${current} · ${piece}` : `${indent}${piece}`;
		if (current.length > 0 && visibleWidth(candidate) > width) {
			lines.push(current);
			current = `${indent}${piece}`;
		} else {
			current = candidate;
		}
	}
	if (current.length > 0) lines.push(current);
	return lines;
}

function layoutTable(columns: readonly TableColumn[], rowCount: number, width: number, gap = 2): TableLayout {
	const measured = columns.map((column) => ({
		column,
		width: Math.max(visibleWidth(column.header), ...column.cells.map((cell) => visibleWidth(cell)), 1),
	}));
	const visible = [...measured];
	const dropped: typeof measured = [];
	const used = () => visible.reduce((sum, entry) => sum + entry.width, 1) + gap * Math.max(0, visible.length - 1);
	while (used() > width && visible.some((entry) => entry.column.drop > 0)) {
		let index = -1;
		let rank = 0;
		visible.forEach((entry, position) => {
			if (entry.column.drop > 0 && entry.column.drop >= rank) {
				rank = entry.column.drop;
				index = position;
			}
		});
		if (index < 0) break;
		dropped.unshift(...visible.splice(index, 1));
	}

	const separator = " ".repeat(gap);
	const line = (cells: readonly string[]) =>
		` ${visible.map((entry, index) => (entry.column.align === "right" ? padLeft(cells[index] ?? "", entry.width) : padRight(cells[index] ?? "", entry.width))).join(separator)}`;
	const rows: string[] = [];
	const extras: string[][] = [];
	for (let row = 0; row < rowCount; row++) {
		rows.push(line(visible.map((entry) => entry.column.cells[row] ?? "")));
		const leftovers = dropped
			.filter((entry) => !entry.column.decorative && (entry.column.cells[row] ?? "").trim().length > 0)
			.map((entry) => `${entry.column.label ?? entry.column.header.toLowerCase()} ${entry.column.cells[row]}`);
		extras.push(leftovers.length > 0 ? wrap(leftovers, width, "   ") : []);
	}
	return { header: line(visible.map((entry) => entry.column.header)), rows, extras, width: used() };
}

export class StatsWidget implements Component {
	private state: WidgetState = { kind: "loading", completed: 0, total: 0 };
	private tab: StatsTab = "overview";
	private range: StatsRange = "all";
	private exact = false;
	private modelOffset = 0;
	private pageSize = MAX_MODEL_PAGE;
	private readonly options: StatsWidgetOptions;

	constructor(options: StatsWidgetOptions) {
		this.options = options;
	}

	getRange(): StatsRange {
		return this.range;
	}

	setLoading(completed = 0, total = 0): void {
		this.state = { kind: "loading", completed, total };
		this.options.requestRender();
	}

	setProgress(completed: number, total: number): void {
		if (this.state.kind !== "loading") return;
		this.state = { kind: "loading", completed, total };
		this.options.requestRender();
	}

	setReady(snapshot: StatsSnapshot): void {
		this.state = { kind: "ready", snapshot };
		this.modelOffset = Math.max(0, Math.min(this.modelOffset, this.listLength(snapshot) - this.pageSize));
		this.options.requestRender();
	}

	/** Row count of the scrollable list on the active tab; the Overview tab does not scroll. */
	private listLength(snapshot: StatsSnapshot): number {
		if (this.tab === "models") return snapshot.models.length;
		if (this.tab === "tools") return snapshot.tools.length;
		if (this.tab === "projects") return snapshot.projects.length;
		return 0;
	}

	setError(message: string): void {
		this.state = { kind: "error", message };
		this.options.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.options.onClose();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.switchTab(1);
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.switchTab(-1);
			return;
		}
		if (data === "r" || data === "R") {
			const next = RANGES[(RANGES.indexOf(this.range) + 1) % RANGES.length]!;
			this.range = next;
			const snapshot = this.options.getSnapshot(next);
			if (snapshot) this.setReady(snapshot);
			return;
		}
		if (data === "e" || data === "E") {
			this.exact = !this.exact;
			this.options.requestRender();
			return;
		}
		if (data === "u" || data === "U") {
			this.options.onRefresh();
			return;
		}
		if (this.state.kind === "ready" && this.tab !== "overview") {
			if (matchesKey(data, Key.down)) {
				this.modelOffset = Math.min(Math.max(0, this.listLength(this.state.snapshot) - this.pageSize), this.modelOffset + 1);
				this.options.requestRender();
			} else if (matchesKey(data, Key.up)) {
				this.modelOffset = Math.max(0, this.modelOffset - 1);
				this.options.requestRender();
			}
		}
	}

	/** Tabs wrap in both directions; the scroll offset is per-tab and resets on every switch. */
	private switchTab(step: number): void {
		const index = TABS.indexOf(this.tab);
		this.tab = TABS[(index + step + TABS.length) % TABS.length]!;
		this.modelOffset = 0;
		this.options.requestRender();
	}

	dispose(): void {
		this.options.onDispose?.();
	}

	invalidate(): void {
		// Rendering uses the live injected theme and has no pre-baked cache.
	}

	render(width: number): string[] {
		if (width <= 0) return [""];
		const lines = this.renderContent(width).map((line) => truncateToWidth(line, width, ""));
		return lines.length > 0 ? lines : [""];
	}

	private tokens(value: number): string {
		return formatTokens(value, this.exact);
	}

	private renderContent(width: number): string[] {
		const { theme } = this.options;
		const lines: string[] = [];
		const selected = (text: string) => theme.bg("selectedBg", theme.fg("accent", theme.bold(` ${text} `)));
		const normal = (text: string) => theme.fg("muted", ` ${text} `);
		const title = " PI STATS ";
		lines.push(theme.fg("borderAccent", "─".repeat(Math.max(1, width))));
		const rangeChip = RANGE_LABELS[this.range];
		const chips = TABS.map((tab) => (tab === this.tab ? selected(TAB_LABELS[tab]) : normal(TAB_LABELS[tab]))).join(" ");
		const chipsWidth = TABS.reduce((sum, tab) => sum + TAB_LABELS[tab].length + 2, 0) + (TABS.length - 1);
		const spacer = " ".repeat(Math.max(1, width - visibleWidth(title) - 2 - chipsWidth - visibleWidth(rangeChip) - 1));
		lines.push(`${theme.fg("accent", theme.bold(title))}  ${chips}${spacer}${theme.fg("dim", rangeChip)}`);

		if (this.state.kind === "loading") {
			const progress = this.state.total > 0 ? ` ${this.state.completed}/${this.state.total}` : "";
			lines.push("", theme.fg("accent", " ◌ ") + theme.fg("text", `Scanning Pi sessions…${progress}`), "");
			lines.push(theme.fg("dim", " Esc close"));
			lines.push(theme.fg("borderMuted", "─".repeat(Math.max(1, width))));
			return lines;
		}
		if (this.state.kind === "error") {
			lines.push("", theme.fg("error", ` Stats unavailable: ${this.state.message}`), "");
			lines.push(theme.fg("dim", " u retry · Esc close"));
			lines.push(theme.fg("borderMuted", "─".repeat(Math.max(1, width))));
			return lines;
		}

		const snapshot = this.state.snapshot;
		lines.push(
			` ${theme.fg("accent", theme.bold(this.tokens(totalTokens(snapshot.allTime))))} ${theme.fg("muted", "tokens all time")} ${theme.fg("dim", `· ${formatCost(snapshot.allTime.cost)} · ${cacheHit(snapshot.allTime)} cache hit`)}`,
		);
		lines.push(...this.renderTab(snapshot, width));
		const scanWarnings: string[] = [];
		if (snapshot.diagnostics.unreadableFiles > 0) scanWarnings.push(`${snapshot.diagnostics.unreadableFiles} unreadable file(s)`);
		if (snapshot.diagnostics.malformedLines > 0) scanWarnings.push(`${snapshot.diagnostics.malformedLines} malformed line(s)`);
		const warning = scanWarnings.length > 0 ? theme.fg("warning", ` · ⚠ ${scanWarnings.join(" · ")}`) : "";
		const exactHint = this.exact ? "e compact" : "e exact";
		const scrollHint = this.tab === "overview" ? "" : " · ↑↓ scroll";
		lines.push(theme.fg("dim", ` Tab/←→ switch${scrollHint} · r range · ${exactHint} · u refresh · Esc close`) + warning);
		lines.push(theme.fg("borderMuted", "─".repeat(Math.max(1, width))));
		return lines;
	}

	private renderScopes(snapshot: StatsSnapshot, width: number): string[] {
		const { theme } = this.options;
		const scopes: Array<[string, UsageTotals]> = [["Current session", snapshot.currentSession]];
		if (snapshot.range !== "all") scopes.push([RANGE_LABELS[snapshot.range], snapshot.period]);
		scopes.push(["All time", snapshot.allTime]);

		const column = (header: string, drop: number, label: string, pick: (usage: UsageTotals) => string): TableColumn => ({
			header,
			drop,
			label,
			align: header === "Scope" ? "left" : "right",
			cells: scopes.map(([, usage]) => pick(usage)),
		});
		const table = layoutTable(
			[
				{ header: "Scope", cells: scopes.map(([name]) => name), align: "left", drop: 0 },
				column("Tokens", 0, "total", (usage) => this.tokens(totalTokens(usage))),
				column("Input", 4, "in", (usage) => this.tokens(usage.input)),
				column("Output", 4, "out", (usage) => this.tokens(usage.output)),
				column("Cache R", 5, "cache r", (usage) => this.tokens(usage.cacheRead)),
				column("Cache W", 6, "cache w", (usage) => this.tokens(usage.cacheWrite)),
				column("Reason", 7, "reason ⊂ output", (usage) => this.tokens(usage.reasoning)),
				column("Cache hit", 3, "cache hit", (usage) => cacheHit(usage)),
				column("Cost", 2, "cost", (usage) => formatCost(usage.cost)),
			],
			scopes.length,
			width,
		);

		const lines = [theme.fg("dim", table.header)];
		table.rows.forEach((row, index) => {
			lines.push(index === table.rows.length - 1 ? theme.fg("text", theme.bold(row)) : theme.fg("text", row));
			for (const extra of table.extras[index] ?? []) lines.push(theme.fg("dim", extra));
		});
		return lines;
	}

	private renderOverview(snapshot: StatsSnapshot, width: number): string[] {
		const { theme } = this.options;
		const scopes = this.renderScopes(snapshot, width);

		const metrics: Array<[string, string, string]> = [
			["Sessions", "Sessions", `${snapshot.sessionCount} (${snapshot.mainSessionCount} main · ${snapshot.subagentSessionCount} sub)`],
			["Active days", "Active", String(snapshot.activeDays)],
			["Streak", "Streak", `${snapshot.currentStreak}d current · ${snapshot.longestStreak}d longest`],
			["Busiest", "Busiest", snapshot.mostActiveDay ? `${snapshot.mostActiveDay.day} · ${this.tokens(snapshot.mostActiveDay.total)}` : "—"],
			["Favorite", "Favorite", snapshot.favoriteModel ?? "—"],
			["Longest span", "Longest", formatDuration(snapshot.longestSessionMs)],
		];
		const left = metrics.filter((_, index) => index % 2 === 0);
		const right = metrics.filter((_, index) => index % 2 === 1);
		const plan = (index: 0 | 1) => {
			const labels = Math.max(...metrics.map((metric) => visibleWidth(metric[index])));
			const columnWidth = (rows: typeof metrics) => labels + 2 + Math.max(...rows.map((metric) => visibleWidth(metric[2])));
			return { index, leftWidth: columnWidth(left), fits: 1 + columnWidth(left) + 2 + columnWidth(right) <= width };
		};
		const chosen = [plan(0), plan(1)].find((candidate) => candidate.fits);
		const labelWidth = Math.max(...metrics.map((metric) => visibleWidth(metric[chosen?.index ?? 0])));
		const cell = (metric: [string, string, string], pad: number) =>
			`${theme.fg("dim", padRight(metric[chosen?.index ?? 0], labelWidth))}  ${theme.fg("text", pad > 0 ? padRight(metric[2], pad) : metric[2])}`;
		const metricLines: string[] = [];
		if (chosen) {
			left.forEach((metric, index) => {
				const other = right[index];
				metricLines.push(` ${cell(metric, chosen.leftWidth - labelWidth)}${other ? cell(other, 0) : ""}`.trimEnd());
			});
		} else {
			for (const metric of metrics) metricLines.push(` ${cell(metric, 0)}`.trimEnd());
		}

		const books = (snapshot.allTime.input + snapshot.allTime.output) / 400_000;
		const comparison =
			width >= 90 && snapshot.range === "all" && books >= 0.1
				? [theme.fg("muted", ` Your input + output are roughly ${books.toFixed(books >= 10 ? 0 : 1)}× the tokens in A Game of Thrones.`)]
				: [];
		const spent = CHROME_ROWS + scopes.length + metricLines.length + comparison.length;
		const heatmap = width >= 72 && spent + HEATMAP_ROWS <= MAX_ROWS ? this.renderHeatmap(snapshot, width) : [];
		return [...scopes, ...heatmap, ...metricLines, ...comparison];
	}

	private renderHeatmap(snapshot: StatsSnapshot, width: number): string[] {
		const { theme } = this.options;
		const cells = Math.max(0, width - HEATMAP_LABEL_WIDTH - 1);
		if (cells < HEATMAP_MIN_WEEKS) return [];
		const today = new Date();
		today.setHours(12, 0, 0, 0);
		const end = new Date(today);
		end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));
		// Always claim the width the terminal offers, up to a year. Weeks before the first
		// recorded day render as empty cells so a short history fills the grid in over time
		// instead of leaving most of a wide row blank.
		const weeks = Math.max(HEATMAP_MIN_WEEKS, Math.min(cells, HEATMAP_MAX_WEEKS));
		const start = new Date(end);
		start.setDate(start.getDate() - weeks * 7 + 1);

		const totals = new Map(snapshot.days.map((day) => [day.day, day.total]));
		const maximum = Math.max(0, ...snapshot.days.map((day) => day.total));
		const glyph = (value: number): string => {
			if (value <= 0 || maximum <= 0) return theme.fg("dim", "·");
			const level = Math.max(1, Math.min(4, Math.ceil((Math.log1p(value) / Math.log1p(maximum)) * 4)));
			if (level === 1) return theme.fg("muted", "░");
			if (level === 2) return theme.fg("success", "▒");
			if (level === 3) return theme.fg("warning", "▓");
			return theme.fg("accent", "█");
		};

		const legend = `less ${theme.fg("dim", "·")}${theme.fg("muted", "░")}${theme.fg("success", "▒")}${theme.fg("warning", "▓")}${theme.fg("accent", "█")} more`;
		const heading = ` ${theme.fg("muted", "Activity")}`;
		const gap = Math.max(1, width - visibleWidth(heading) - visibleWidth(legend) - 1);
		const lines = [`${heading}${" ".repeat(gap)}${theme.fg("dim", legend)}`];

		let months = " ".repeat(HEATMAP_LABEL_WIDTH);
		let lastLabel = -4;
		for (let week = 0; week < weeks; week++) {
			const date = new Date(start);
			date.setDate(date.getDate() + week * 7);
			const previous = new Date(date);
			previous.setDate(previous.getDate() - 7);
			if ((week === 0 || date.getMonth() !== previous.getMonth()) && week - lastLabel >= 4 && week + 3 <= weeks) {
				months += MONTHS[date.getMonth()]!;
				lastLabel = week;
				week += 2;
			} else {
				months += " ";
			}
		}
		lines.push(theme.fg("dim", months));

		for (let weekday = 0; weekday < 7; weekday++) {
			const label = weekday === 0 ? "Mon" : weekday === 2 ? "Wed" : weekday === 4 ? "Fri" : "   ";
			let row = ` ${theme.fg("dim", label)}  `;
			for (let week = 0; week < weeks; week++) {
				const date = new Date(start);
				date.setDate(date.getDate() + week * 7 + weekday);
				row += date.getTime() > today.getTime() ? " " : glyph(totals.get(localDay(date.getTime())) ?? 0);
			}
			lines.push(row);
		}
		return lines;
	}

	private renderTab(snapshot: StatsSnapshot, width: number): string[] {
		if (this.tab === "models") return this.renderModels(snapshot, width);
		if (this.tab === "tools") return this.renderTools(snapshot, width);
		if (this.tab === "projects") return this.renderProjects(snapshot, width);
		return this.renderOverview(snapshot, width);
	}

	/**
	 * Shared body for the ranked tabs: one layout across data rows plus a trailing summary row,
	 * so column widths stay stable while scrolling and the summary aligns exactly.
	 */
	private renderRanked(columns: TableColumn[], dataRows: number, width: number, noun: string): string[] {
		const { theme } = this.options;
		const entries = dataRows + 1;
		const summaryIndex = entries - 1;
		const table = layoutTable(columns, entries, width);

		const rowsPerEntry = 1 + Math.max(0, ...table.extras.slice(0, summaryIndex).map((extra) => extra.length));
		const summaryRows = 2 + (table.extras[summaryIndex]?.length ?? 0);
		const budget = MAX_ROWS - CHROME_ROWS - 1 - summaryRows - 1;
		this.pageSize = Math.max(MIN_MODEL_PAGE, Math.min(MAX_MODEL_PAGE, Math.floor(budget / rowsPerEntry)));
		const start = Math.min(this.modelOffset, Math.max(0, dataRows - this.pageSize));
		this.modelOffset = start;
		const end = Math.min(dataRows, start + this.pageSize);

		const lines = [theme.fg("dim", table.header)];
		for (let index = start; index < end; index++) {
			lines.push(theme.fg("text", table.rows[index] ?? ""));
			for (const extra of table.extras[index] ?? []) lines.push(theme.fg("dim", extra));
		}
		lines.push(theme.fg("borderMuted", ` ${"─".repeat(Math.max(1, Math.min(width - 1, table.width)))}`));
		lines.push(theme.fg("muted", table.rows[summaryIndex] ?? ""));
		for (const extra of table.extras[summaryIndex] ?? []) lines.push(theme.fg("dim", extra));
		if (dataRows > this.pageSize) {
			lines.push(theme.fg("dim", ` ↑↓ ${noun} ${start + 1}-${end} of ${dataRows}`));
		}
		return lines;
	}

	/** Proportional bar shared by the ranked tabs, scaled to the largest share in the list. */
	private shareBar(share: number, maximum: number): string {
		if (maximum <= 0) return "";
		const filled = Math.max(0, Math.min(6, (share / maximum) * 6));
		const whole = Math.floor(filled);
		const eighths = Math.round((filled - whole) * 8);
		const partial = eighths > 0 ? "▏▎▍▌▋▊▉█"[eighths - 1]! : "";
		return padRight("█".repeat(whole) + partial, 6);
	}

	private renderTools(snapshot: StatsSnapshot, width: number): string[] {
		const { theme } = this.options;
		if (snapshot.tools.length === 0) return [theme.fg("muted", ` No tool calls in ${RANGE_LABELS[snapshot.range].toLowerCase()}.`)];

		const calls = snapshot.tools.reduce((sum, tool) => sum + tool.calls, 0);
		const errors = snapshot.tools.reduce((sum, tool) => sum + tool.errors, 0);
		const summaryRow: ToolStats = {
			toolName: `${snapshot.tools.length} tool${snapshot.tools.length === 1 ? "" : "s"}`,
			calls,
			errors,
			share: 1,
		};
		const rows = [...snapshot.tools, summaryRow];
		const maximum = Math.max(0, ...snapshot.tools.map((tool) => tool.share));
		const isSummary = (index: number) => index >= snapshot.tools.length;
		const errorRate = (tool: ToolStats) => (tool.calls > 0 ? `${((tool.errors / tool.calls) * 100).toFixed(1)}%` : "—");
		const columns: TableColumn[] = [
			{ header: "Tool", cells: rows.map((tool) => tool.toolName), align: "left", drop: 0 },
			{ header: "Source", cells: rows.map((tool, index) => (isSummary(index) ? "" : (tool.source ?? "—"))), align: "left", drop: 2, label: "from" },
			{ header: "Calls", cells: rows.map((tool) => tool.calls.toLocaleString("en-US")), align: "right", drop: 0 },
			{ header: "Share", cells: rows.map((tool) => `${(tool.share * 100).toFixed(1)}%`), align: "right", drop: 3, label: "share" },
			{ header: "", cells: rows.map((tool, index) => (isSummary(index) ? "" : this.shareBar(tool.share, maximum))), align: "left", drop: 4, decorative: true },
			{ header: "Errors", cells: rows.map((tool) => tool.errors.toLocaleString("en-US")), align: "right", drop: 1, label: "errors" },
			{ header: "Err %", cells: rows.map((tool) => errorRate(tool)), align: "right", drop: 1, label: "err rate" },
		];
		return this.renderRanked(columns, snapshot.tools.length, width, "tools");
	}

	private renderProjects(snapshot: StatsSnapshot, width: number): string[] {
		const { theme } = this.options;
		if (snapshot.projects.length === 0) return [theme.fg("muted", ` No project activity in ${RANGE_LABELS[snapshot.range].toLowerCase()}.`)];

		const sessions = snapshot.projects.reduce((sum, project) => sum + project.sessions, 0);
		const total = snapshot.projects.reduce((sum, project) => sum + project.total, 0);
		const cost = snapshot.projects.reduce((sum, project) => sum + project.cost, 0);
		const summaryRow: ProjectStats = {
			cwd: "",
			label: `${snapshot.projects.length} project${snapshot.projects.length === 1 ? "" : "s"}`,
			sessions,
			total,
			cost,
			share: 1,
		};
		const rows = [...snapshot.projects, summaryRow];
		const maximum = Math.max(0, ...snapshot.projects.map((project) => project.share));
		const isSummary = (index: number) => index >= snapshot.projects.length;
		const columns: TableColumn[] = [
			{ header: "Project", cells: rows.map((project) => project.label), align: "left", drop: 0 },
			{ header: "Sessions", cells: rows.map((project) => project.sessions.toLocaleString("en-US")), align: "right", drop: 1, label: "sessions" },
			{ header: "Share", cells: rows.map((project) => `${(project.share * 100).toFixed(1)}%`), align: "right", drop: 3, label: "share" },
			{ header: "", cells: rows.map((project, index) => (isSummary(index) ? "" : this.shareBar(project.share, maximum))), align: "left", drop: 4, decorative: true },
			{ header: "Total", cells: rows.map((project) => this.tokens(project.total)), align: "right", drop: 0 },
			{ header: "Cost", cells: rows.map((project) => formatCost(project.cost)), align: "right", drop: 1, label: "cost" },
			{ header: "Path", cells: rows.map((project, index) => (isSummary(index) ? "" : project.cwd)), align: "left", drop: 5, label: "path" },
		];
		return this.renderRanked(columns, snapshot.projects.length, width, "projects");
	}

	private renderModels(snapshot: StatsSnapshot, width: number): string[] {
		const { theme } = this.options;
		if (snapshot.models.length === 0) return [theme.fg("muted", ` No model usage in ${RANGE_LABELS[snapshot.range].toLowerCase()}.`)];

		const totals = snapshot.models.reduce<UsageTotals & { total: number }>(
			(sum, model) => ({
				input: sum.input + model.input,
				output: sum.output + model.output,
				cacheRead: sum.cacheRead + model.cacheRead,
				cacheWrite: sum.cacheWrite + model.cacheWrite,
				reasoning: sum.reasoning + model.reasoning,
				cost: sum.cost + model.cost,
				calls: sum.calls + model.calls,
				total: sum.total + model.total,
			}),
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, calls: 0, total: 0 },
		);
		const summaryRow: ModelStats = { ...totals, model: `${snapshot.models.length} model${snapshot.models.length === 1 ? "" : "s"}`, share: 1 };
		const entries = [...snapshot.models, summaryRow];
		return this.renderRanked(this.modelColumns(entries, snapshot.models), snapshot.models.length, width, "models");
	}

	private modelColumns(rows: readonly ModelStats[], ranked: readonly ModelStats[]): TableColumn[] {
		const maximum = Math.max(0, ...ranked.map((model) => model.share));
		const isSummary = (index: number) => index >= ranked.length;
		const bar = (share: number): string => this.shareBar(share, maximum);
		return [
			{ header: "Model", cells: rows.map((model) => model.model), align: "left", drop: 0 },
			{ header: "Calls", cells: rows.map((model) => model.calls.toLocaleString("en-US")), align: "right", drop: 1, label: "calls" },
			{ header: "Share", cells: rows.map((model) => `${(model.share * 100).toFixed(1)}%`), align: "right", drop: 2, label: "share" },
			{ header: "", cells: rows.map((model, index) => (isSummary(index) ? "" : bar(model.share))), align: "left", drop: 3, decorative: true },
			{ header: "Total", cells: rows.map((model) => this.tokens(model.total)), align: "right", drop: 0 },
			{ header: "Input", cells: rows.map((model) => this.tokens(model.input)), align: "right", drop: 4, label: "in" },
			{ header: "Output", cells: rows.map((model) => this.tokens(model.output)), align: "right", drop: 4, label: "out" },
			{
				header: "Cache R/W",
				cells: rows.map((model) => `${this.tokens(model.cacheRead)}/${this.tokens(model.cacheWrite)}`),
				align: "right",
				drop: 5,
				label: "cache",
			},
			{ header: "Reason", cells: rows.map((model) => this.tokens(model.reasoning)), align: "right", drop: 6, label: "reason ⊂ output" },
			{ header: "Cost", cells: rows.map((model) => formatCost(model.cost)), align: "right", drop: 1, label: "cost" },
		];
	}
}
