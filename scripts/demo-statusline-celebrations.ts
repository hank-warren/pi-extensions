#!/usr/bin/env -S node --import tsx
// Preview the cache-celebration styles that actually ship, on real statuslines.
//
//   npm run demo:celebrations                  # every style, default theme
//   npm run demo:celebrations -- --matrix      # every style x every theme
//   npm run demo:celebrations -- --theme=dracula --percent=99
//
// Unlike scripts/demo-cache-flash-variants.ts (a detached playground for
// inventing new animations), this imports CELEBRATION_STYLES and
// STATUSLINE_THEMES directly, so what you see is exactly what /statusline
// renders. Edit packages/pi-statusline/celebration-styles.ts and re-run.
//
// Keys: t / T cycle theme, [ / ] change speed, space pause, q quit.

import {
	CACHE_CELEBRATION_FRAME_INTERVAL_MS,
	CACHE_HIT_THRESHOLD,
} from "../packages/pi-statusline/cache-celebration.ts";
import {
	cacheBadgeText,
	CELEBRATION_STYLE_NAMES,
	CELEBRATION_STYLES,
	type CelebrationStyleName,
} from "../packages/pi-statusline/celebration-styles.ts";
import { renderStatusline, type StatuslineData } from "../packages/pi-statusline/index.ts";
import { defaultSettings } from "../packages/pi-statusline/settings.ts";
import { STATUSLINE_THEMES, THEME_NAMES, type StatuslineThemeName } from "../packages/pi-statusline/themes.ts";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

interface Options {
	percent: number;
	theme: StatuslineThemeName;
	matrix: boolean;
	style?: CelebrationStyleName;
}

function parseArgs(argv: string[]): Options {
	const minPercent = Math.round(CACHE_HIT_THRESHOLD * 100);
	const options: Options = { percent: 96, theme: "default", matrix: false };

	for (const arg of argv) {
		const [flag, raw] = arg.startsWith("--") ? arg.slice(2).split("=", 2) : ["percent", arg];
		if (flag === "matrix") {
			options.matrix = true;
		} else if (flag === "percent") {
			const value = Number(raw);
			if (!Number.isFinite(value) || value < minPercent || value > 100) {
				fail(`--percent must be between ${minPercent} and 100`);
			}
			options.percent = Math.round(value);
		} else if (flag === "theme") {
			if (!THEME_NAMES.includes(raw as StatuslineThemeName)) fail(`--theme must be one of: ${THEME_NAMES.join(", ")}`);
			options.theme = raw as StatuslineThemeName;
		} else if (flag === "style") {
			if (!CELEBRATION_STYLE_NAMES.includes(raw as CelebrationStyleName)) {
				fail(`--style must be one of: ${CELEBRATION_STYLE_NAMES.join(", ")}`);
			}
			options.style = raw as CelebrationStyleName;
		} else {
			fail(`unknown flag --${flag}`);
		}
	}
	return options;
}

function fail(message: string): never {
	console.error(`demo-statusline-celebrations: ${message}`);
	console.error("Usage: npm run demo:celebrations -- [--matrix] [--theme=NAME] [--style=NAME] [--percent=N]");
	process.exit(1);
}

const options = parseArgs(process.argv.slice(2));
if (!process.stdout.isTTY) fail("this demo requires an interactive terminal");

const styles = options.style ? [options.style] : CELEBRATION_STYLE_NAMES;
const labelWidth = Math.max(...styles.map((name) => name.length), ...THEME_NAMES.map((name) => name.length));

const data: StatuslineData = {
	model: "claude-opus-4-6",
	cwd: "pi-extensions",
	cwdGit: { branch: "feat/statusline-celebration-styles", dirty: true, behind: 0 },
	contextTokens: 168_000,
	contextWindow: 1_000_000,
	worktrees: [{ path: "/w", repo: "pi-extensions", branch: "feat/celebrations", dirty: true, behind: 0, pr: 106, prState: "OPEN" }],
	sessionId: "019fafa7-29c0-7e99-9f82-5794d5721848",
	usage: { claude: { fiveHour: 91, sevenDay: 53 }, codex: { weekly: 23 } },
};

let theme = options.theme;
let intervalMs = CACHE_CELEBRATION_FRAME_INTERVAL_MS;
let frame = 0;
let paused = false;
let renderedLines = 0;
let timer: ReturnType<typeof setInterval> | undefined;

const label = (text: string): string => `${DIM}${text.padEnd(labelWidth)}${RESET}`;

/** One statusline per style, so spacing and truncation match the real footer. */
function styleRows(width: number): string[] {
	const settings = { ...defaultSettings("/home/hank"), theme, showSessionId: false, showWorktrees: false };
	return styles.map((style) => {
		const line = renderStatusline(
			{ ...data, cacheCelebration: { percent: options.percent, frame } },
			Math.max(20, width - labelWidth - 1),
			{ ...settings, cacheCelebrationStyle: style },
		)[0];
		return `${label(style)} ${line}`;
	});
}

/** Badges only, every style against every theme. */
function matrixRows(): string[] {
	const badge = cacheBadgeText(options.percent);
	const header = `${" ".repeat(labelWidth)} ${styles.map((s) => `${DIM}${s.padEnd(badge.length)}${RESET}`).join(" ")}`;
	const rows = THEME_NAMES.map((name) => {
		const palette = STATUSLINE_THEMES[name];
		const cells = styles.map((style) => CELEBRATION_STYLES[style](badge, frame, palette));
		return `${label(name)} ${cells.join(" ")}`;
	});
	return [header, ...rows];
}

function draw(): void {
	const width = Math.max(40, process.stdout.columns ?? 100);
	const body = options.matrix ? matrixRows() : styleRows(width);
	const status =
		`${DIM}frame ${String(frame).padStart(4)} \u00b7 ${intervalMs}ms` +
		`${options.matrix ? "" : ` \u00b7 theme ${BOLD}${theme}${RESET}${DIM}`}` +
		`${paused ? " \u00b7 PAUSED" : ""} \u00b7 t theme \u00b7 [ ] speed \u00b7 space pause \u00b7 q quit${RESET}`;
	const lines = [...body, "", status];

	if (renderedLines > 0) process.stdout.write(`\x1b[${renderedLines}A`);
	process.stdout.write(lines.map((line) => `\r\x1b[2K${line}`).join("\n"));
	process.stdout.write("\n");
	renderedLines = lines.length;
}

function restart(): void {
	if (timer) clearInterval(timer);
	timer = setInterval(() => {
		if (paused) return;
		frame++;
		draw();
	}, intervalMs);
	timer.unref?.();
}

function cleanup(code = 0): never {
	if (timer) clearInterval(timer);
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	process.stdout.write("\x1b[?25h\n");
	process.exit(code);
}

function onKey(chunk: Buffer): void {
	const key = chunk.toString();
	const shift = (delta: number) => {
		const index = (THEME_NAMES.indexOf(theme) + delta + THEME_NAMES.length) % THEME_NAMES.length;
		theme = THEME_NAMES[index];
	};
	if (key === "q" || key === "\x03") cleanup();
	else if (key === "t") shift(1);
	else if (key === "T") shift(-1);
	else if (key === "]") intervalMs = Math.min(500, intervalMs + 20), restart();
	else if (key === "[") intervalMs = Math.max(20, intervalMs - 20), restart();
	else if (key === " ") paused = !paused;
	draw();
}

console.log(
	`${BOLD}Cache celebration styles${RESET}${DIM} \u2014 ` +
		`${options.matrix ? "style x theme matrix" : `${styles.length} styles`} at ${options.percent}%. ` +
		`Edit packages/pi-statusline/celebration-styles.ts and re-run.${RESET}\n`,
);

process.stdout.write("\x1b[?25l");
if (process.stdin.isTTY) {
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("data", onKey);
}
process.on("SIGINT", () => cleanup(130));
process.on("SIGTERM", () => cleanup(143));
process.stdout.on("resize", draw);

draw();
restart();
