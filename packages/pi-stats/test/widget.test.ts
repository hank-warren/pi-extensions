import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { StatsWidget, formatCost, formatTokens } from "../widget.ts";
import type { ModelStats, ProjectStats, StatsRange, StatsSnapshot, ToolStats, UsageTotals } from "../types.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const usage = (factor = 1): UsageTotals => ({
	input: 1_000 * factor,
	output: 500 * factor,
	cacheRead: 2_000 * factor,
	cacheWrite: 250 * factor,
	reasoning: 100 * factor,
	cost: 1.25 * factor,
	calls: factor,
});

function model(index: number): ModelStats {
	const totals = usage(index + 1);
	return { ...totals, model: `provider/model-${index}`, total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite, share: 0.1 };
}

function tool(index: number, overrides: Partial<ToolStats> = {}): ToolStats {
	return {
		toolName: `tool-${index}`,
		source: index === 0 ? "builtin" : "pi-example",
		calls: 100 - index * 10,
		errors: index,
		share: 0.5 - index * 0.1,
		...overrides,
	};
}

function project(index: number, overrides: Partial<ProjectStats> = {}): ProjectStats {
	return {
		cwd: `/home/user/repos/project-${index}`,
		label: `project-${index}`,
		sessions: 5 - index,
		total: 100_000 - index * 10_000,
		cost: 12.5 - index,
		share: 0.5 - index * 0.1,
		...overrides,
	};
}

function snapshot(
	range: StatsRange = "all",
	models = [model(0), model(1)],
	tools = [tool(0), tool(1)],
	projects = [project(0), project(1)],
): StatsSnapshot {
	return {
		range,
		allTime: usage(10),
		period: usage(range === "all" ? 10 : 2),
		currentSession: usage(1),
		models,
		tools,
		projects,
		days: [
			{ day: "2026-08-10", total: 10_000 },
			{ day: "2026-08-11", total: 20_000 },
		],
		sessionCount: 12,
		mainSessionCount: 8,
		subagentSessionCount: 4,
		activeDays: 2,
		currentStreak: 2,
		longestStreak: 5,
		mostActiveDay: { day: "2026-08-11", total: 20_000 },
		favoriteModel: "provider/model-0",
		longestSessionMs: 90 * 60_000,
		diagnostics: { discoveredFiles: 12, parsedFiles: 1, reusedFiles: 11, ignoredFiles: 0, unreadableFiles: 0, malformedLines: 0 },
	};
}

function createWidget(models?: ModelStats[], tools?: ToolStats[], projects?: ProjectStats[]) {
	let closed = 0;
	let refreshed = 0;
	let disposed = 0;
	let renders = 0;
	const widget = new StatsWidget({
		theme,
		requestRender: () => renders++,
		onClose: () => closed++,
		onRefresh: () => refreshed++,
		onDispose: () => disposed++,
		getSnapshot: (range) => snapshot(range, models, tools, projects),
	});
	return { widget, counts: () => ({ closed, refreshed, disposed, renders }) };
}

/** Tab presses needed to reach a tab from Overview. */
const TAB_STEPS = { overview: 0, models: 1, tools: 2, projects: 3 } as const;

function goToTab(widget: StatsWidget, tab: keyof typeof TAB_STEPS): void {
	for (let step = 0; step < TAB_STEPS[tab]; step++) widget.handleInput("\t");
}

test("formats compact, exact, and monetary totals", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1_500), "1.5K");
	assert.equal(formatTokens(12_000), "12K");
	assert.equal(formatTokens(1_250_000), "1.3M");
	assert.equal(formatTokens(1_500_000_000), "1.5B");
	assert.equal(formatTokens(1_486_201_553, true), "1,486,201,553");
	assert.equal(formatCost(0), "$0.00");
	assert.equal(formatCost(5.871), "$5.87");
	assert.equal(formatCost(2_054.9812), "$2,054.98");
});

test("renders loading, error, empty, and ready states", () => {
	const { widget } = createWidget();
	widget.setProgress(2, 10);
	assert.match(widget.render(80).join("\n"), /Scanning Pi sessions… 2\/10/);
	widget.setError("permission denied");
	assert.match(widget.render(80).join("\n"), /Stats unavailable: permission denied/);
	widget.setReady(snapshot("all", [], [], []));
	widget.handleInput("\t");
	assert.match(widget.render(80).join("\n"), /No model usage/);
	widget.handleInput("\t");
	assert.match(widget.render(80).join("\n"), /No tool calls/);
	widget.handleInput("\t");
	assert.match(widget.render(80).join("\n"), /No project activity/);
	// Four tabs now, so one more Tab wraps back to Overview.
	widget.handleInput("\t");
	widget.setReady(snapshot());
	const ready = widget.render(120).join("\n");
	assert.match(ready, /tokens all time/);
	assert.match(ready, /Scope\s+Tokens\s+Input\s+Output\s+Cache R\s+Cache W\s+Reason\s+Cache hit\s+Cost/);
	assert.match(ready, /Current session/);
	assert.match(ready, /8 main · 4 sub/);
	assert.match(ready, /Activity\s+less ·░▒▓█ more/);
});

test("heatmap fills the available width with empty weeks instead of shrinking to the history", () => {
	const { widget } = createWidget();
	// The snapshot holds two active days, far less than a year of history.
	widget.setReady(snapshot());
	const weekRow = (width: number) => {
		const row = widget.render(width).find((line) => line.startsWith(" Mon"));
		assert.ok(row, `heatmap renders at ${width} columns`);
		return visibleWidth(row!) - 6;
	};
	assert.equal(weekRow(120), 53);
	// Capped at a year, so a very wide terminal does not repeat a partial second year.
	assert.equal(weekRow(200), 53);
	// The narrowest width that still draws a heatmap keeps every column inside the row.
	assert.ok(weekRow(72) + 6 <= 72);
});

test("keeps dropped columns visible as labelled continuation values", () => {
	const { widget } = createWidget();
	widget.setReady(snapshot());
	const narrow = widget.render(58).join("\n");
	assert.match(narrow, /Scope\s+Tokens/);
	assert.match(narrow, /reason ⊂ output/);
	assert.match(narrow, /cache w/);
	assert.doesNotMatch(narrow, /Activity/);
});

test("toggles exact totals and back to compact", () => {
	const models = [model(0), model(1)];
	const { widget } = createWidget(models);
	widget.setReady(snapshot("all", models));
	assert.match(widget.render(120).join("\n"), /38K tokens all time/);
	assert.match(widget.render(120).join("\n"), /e exact/);
	widget.handleInput("e");
	const exact = widget.render(120).join("\n");
	assert.match(exact, /37,500 tokens all time/);
	assert.match(exact, /e compact/);
	widget.handleInput("e");
	assert.match(widget.render(120).join("\n"), /38K tokens all time/);
});

test("models table ranks with bars and reconciles in a totals row", () => {
	const models = Array.from({ length: 3 }, (_, index) => model(index));
	const { widget } = createWidget(models);
	widget.setReady(snapshot("all", models));
	widget.handleInput("\t");
	const rendered = widget.render(120);
	const body = rendered.join("\n");
	assert.match(body, /Model\s+Calls\s+Share\s+Total\s+Input\s+Output\s+Cache R\/W\s+Reason\s+Cost/);
	assert.match(body, /█/);
	const summary = rendered.find((line) => line.includes("3 models"));
	assert.ok(summary, "totals row is rendered");
	const expected = models.reduce((sum, entry) => sum + entry.total, 0);
	assert.match(summary!, new RegExp(formatTokens(expected).replace(".", "\\.")));
	assert.match(summary!, /\$7\.50/);
});

test("tools table ranks by calls, labels the registering package, and reports error rate", () => {
	const tools = [
		tool(0, { toolName: "bash", source: "builtin", calls: 346, errors: 12, share: 0.6 }),
		tool(1, { toolName: "vault_capture", source: "pi-obsidian", calls: 9, errors: 0, share: 0.2 }),
		// A tool from an extension that is no longer installed has no live registry entry.
		tool(2, { toolName: "retired_tool", source: undefined, calls: 4, errors: 4, share: 0.2 }),
	];
	const { widget } = createWidget(undefined, tools);
	widget.setReady(snapshot("all", undefined, tools));
	goToTab(widget, "tools");
	const rendered = widget.render(120);
	const body = rendered.join("\n");
	assert.match(body, /Tool\s+Source\s+Calls\s+Share\s+Errors\s+Err %/);
	assert.match(body, /bash\s+builtin\s+346\s+60\.0%/);
	assert.match(body, /vault_capture\s+pi-obsidian/, "extension tools show their package");
	assert.match(body, /retired_tool\s+—/, "uninstalled tools stay listed without a source");
	assert.match(body, /3\.5%/, "bash error rate is 12/346");
	assert.match(body, /100\.0%/, "a fully failing tool reports a 100% error rate");
	const summary = rendered.find((line) => line.includes("3 tools"));
	assert.ok(summary, "totals row is rendered");
	assert.match(summary!, /359/, "totals row sums every call");
	assert.match(summary!, /16/, "totals row sums every error");
});

test("projects table rolls sessions up by working directory", () => {
	const projects = [
		project(0, { cwd: "/home/user/repos/pi-extensions", label: "pi-extensions", sessions: 9, total: 500_000, cost: 20, share: 0.8 }),
		project(1, { cwd: "/home/user/repos/infra", label: "infra", sessions: 2, total: 125_000, cost: 5, share: 0.2 }),
	];
	const { widget } = createWidget(undefined, undefined, projects);
	widget.setReady(snapshot("all", undefined, undefined, projects));
	goToTab(widget, "projects");
	const rendered = widget.render(140);
	const body = rendered.join("\n");
	assert.match(body, /Project\s+Sessions\s+Share\s+Total\s+Cost/);
	assert.match(body, /pi-extensions\s+9\s+80\.0%/);
	assert.match(body, /\/home\/user\/repos\/infra/, "the full path is available at wide widths");
	const summary = rendered.find((line) => line.includes("2 projects"));
	assert.ok(summary, "totals row is rendered");
	assert.match(summary!, /11/, "totals row sums sessions");
	assert.match(summary!, /\$25\.00/, "totals row sums cost");
});

test("tab switching wraps in both directions and resets the scroll offset", () => {
	const models = Array.from({ length: 14 }, (_, index) => model(index));
	const { widget } = createWidget(models);
	widget.setReady(snapshot("all", models));
	goToTab(widget, "models");
	widget.handleInput("\x1b[B");
	assert.match(widget.render(130).join("\n"), /models 2-11 of 14/);
	// Leaving and returning starts the list at the top again.
	widget.handleInput("\t");
	widget.handleInput("\x1b[D");
	assert.match(widget.render(130).join("\n"), /models 1-10 of 14/);
	// Left from Overview wraps to the last tab.
	widget.handleInput("\x1b[D");
	widget.handleInput("\x1b[D");
	assert.match(widget.render(130).join("\n"), /Project\s+Sessions/);
	// Right from the last tab wraps back to Overview.
	widget.handleInput("\x1b[C");
	assert.match(widget.render(130).join("\n"), /Scope\s+Tokens/);
});

test("switches tabs, cycles ranges, scrolls models, refreshes, and closes", () => {
	const models = Array.from({ length: 14 }, (_, index) => model(index));
	const { widget, counts } = createWidget(models);
	widget.setReady(snapshot("all", models));
	widget.handleInput("r");
	assert.match(widget.render(90).join("\n"), /Last 7 days/);
	widget.handleInput("\t");
	assert.match(widget.render(130).join("\n"), /provider\/model-0/);
	assert.match(widget.render(130).join("\n"), /models 1-10 of 14/);
	widget.handleInput("\x1b[B");
	let scrolled = widget.render(130).join("\n");
	assert.doesNotMatch(scrolled, /provider\/model-0\b/);
	assert.match(scrolled, /models 2-11 of 14/);
	for (let index = 0; index < 10; index++) widget.handleInput("\x1b[B");
	assert.match(widget.render(130).join("\n"), /models 5-14 of 14/);
	widget.handleInput("\x1b[A");
	scrolled = widget.render(130).join("\n");
	assert.match(scrolled, /models 4-13 of 14/);
	widget.handleInput("u");
	widget.handleInput("\x1b");
	assert.equal(counts().refreshed, 1);
	assert.equal(counts().closed, 1);
	widget.dispose();
	assert.equal(counts().disposed, 1);
});

test("all states obey strict width bounds and invalidation is safe", () => {
	const { widget } = createWidget();
	const states = [
		() => widget.setLoading(1, 2),
		() => widget.setError("a very long failure message that should truncate"),
		() => widget.setReady(snapshot("all", Array.from({ length: 10 }, (_, index) => model(index)))),
	];
	for (const setState of states) {
		setState();
		for (const width of [0, 1, 8, 30, 60, 120]) {
			for (const line of widget.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
		}
	}
	widget.invalidate();
});

test("dashboard stays within a standard 24-row terminal", () => {
	const models = Array.from({ length: 14 }, (_, index) => model(index));
	const tools = Array.from({ length: 20 }, (_, index) => tool(index));
	const projects = Array.from({ length: 18 }, (_, index) => project(index));
	const widths = [40, 60, 72, 80, 100, 120, 200];
	for (const exact of [false, true]) {
		for (const tab of ["overview", "models", "tools", "projects"] as const) {
			// A fresh widget per tab keeps the starting tab and scroll offset deterministic.
			const { widget } = createWidget(models, tools, projects);
			if (exact) widget.handleInput("e");
			for (const range of ["all", "7d", "30d"] as const) {
				widget.setReady(snapshot(range, models, tools, projects));
				goToTab(widget, tab);
				for (const width of widths) {
					const rows = widget.render(width).length;
					assert.ok(rows <= 24, `${tab} ${range} at ${width} columns used ${rows} rows (exact=${exact})`);
				}
			}
		}
	}
});
