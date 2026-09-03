#!/usr/bin/env -S node --import tsx
// Preview candidate cache-celebration animations side by side before changing
// the extension. Edit or add entries in VARIANTS below and re-run to iterate:
//
//   npm run demo:cache-flash-variants          # loops until Ctrl+C
//   npm run demo:cache-flash-variants -- 97    # custom percentage
//
// Every variant animates simultaneously on its own statusline, driven by the
// same 80 ms frame counter the real extension uses.

import { CACHE_HIT_THRESHOLD } from "../packages/pi-statusline/cache-celebration.ts";

const BLUE = "\x1b[38;2;0;153;255m";
const YELLOW = "\x1b[38;2;230;200;0m";
const WHITE = "\x1b[38;2;220;220;220m";
const CYAN = "\x1b[38;2;86;182;194m";
const GREEN = "\x1b[38;2;0;175;80m";
const ORANGE = "\x1b[38;2;255;176;85m";
const RED = "\x1b[38;2;255;85;85m";
const NEON_CYAN = "\x1b[38;2;0;255;255m";
const NEON_BLUE = "\x1b[38;2;0;125;255m";
const NEON_MAGENTA = "\x1b[38;2;255;0;255m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// Base demo clock. The real extension ticks at 80 ms, but a finer clock here
// lets us preview faster flashes; hold times below are expressed in ms.
const FRAME_INTERVAL_MS = 20;

type BadgeRenderer = (badge: string, frame: number) => string;

function wholeBadge(color: string, badge: string): string {
	return `${BOLD}${color}${badge}${RESET}`;
}

/** Alternate the whole badge between two colors, holding each for holdMs. */
function flash(colorA: string, colorB: string, holdMs: number): BadgeRenderer {
	const holdFrames = Math.max(1, Math.round(holdMs / FRAME_INTERVAL_MS));
	return (badge, frame) => wholeBadge(Math.floor(frame / holdFrames) % 2 === 0 ? colorA : colorB, badge);
}

/** Blend two truecolor foregrounds; t in [0,1]. */
function blend(from: [number, number, number], to: [number, number, number], t: number): string {
	const channel = (index: number): number => Math.round(from[index] + (to[index] - from[index]) * t);
	return `\x1b[38;2;${channel(0)};${channel(1)};${channel(2)}m`;
}

const BLUE_RGB: [number, number, number] = [0, 153, 255];
const YELLOW_RGB: [number, number, number] = [230, 200, 0];

const BRIGHT_WHITE = "\x1b[38;2;255;255;255m";
const CYAN_RGB: [number, number, number] = [0, 255, 255];
const WHITE_RGB: [number, number, number] = [255, 255, 255];

function rgb(r: number, g: number, b: number): string {
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** Deterministic pseudo-random in [0,1) from a frame/index pair. */
function jitter(frame: number, index: number): number {
	const n = Math.sin(frame * 127.1 + index * 311.7) * 43758.5453;
	return n - Math.floor(n);
}

/** Truecolor for a rotating hue wheel; speed is degrees per frame. */
function hue(frame: number, speed: number): string {
	const h = (frame * speed) % 360;
	const c = (offset: number): number => {
		const x = (h / 60 + offset) % 6;
		return Math.round(255 * Math.max(0, Math.min(1, 2 - Math.abs(x - 2))));
	};
	return rgb(c(2), c(0), c(4));
}

const VARIANTS: { name: string; render: BadgeRenderer }[] = [
	{
		// Baseline: what ships today (80 ms per-character neon wave).
		name: "current wave      ",
		render: (badge, frame) => {
			const wave = [NEON_CYAN, NEON_CYAN, NEON_BLUE, NEON_BLUE, NEON_MAGENTA, NEON_MAGENTA];
			const waveFrame = Math.floor((frame * FRAME_INTERVAL_MS) / 80);
			return Array.from(badge)
				.map((character, index) => `${BOLD}${wave[(index + waveFrame) % wave.length]}${character}${RESET}`)
				.join("");
		},
	},
	{ name: "magenta/cyan 40ms ", render: flash(NEON_MAGENTA, NEON_CYAN, 40) },
	{ name: "magenta/cyan 60ms ", render: flash(NEON_MAGENTA, NEON_CYAN, 60) },
	{ name: "magenta/cyan 80ms ", render: flash(NEON_MAGENTA, NEON_CYAN, 80) },
	{ name: "magenta/cyan 120ms", render: flash(NEON_MAGENTA, NEON_CYAN, 120) },
	{ name: "blue/yellow 40ms  ", render: flash(BLUE, YELLOW, 40) },
	{ name: "blue/yellow 80ms  ", render: flash(BLUE, YELLOW, 80) },
	{ name: "blue/yellow 160ms ", render: flash(BLUE, YELLOW, 160) },
	{ name: "cyan/white 40ms   ", render: flash(NEON_CYAN, BRIGHT_WHITE, 40) },
	{ name: "cyan/white 80ms   ", render: flash(NEON_CYAN, BRIGHT_WHITE, 80) },
	{
		// Smooth sinusoidal blue↔yellow pulse instead of a hard cut.
		name: "blue/yellow pulse ",
		render: (badge, frame) => {
			const t = (Math.sin((frame / 24) * Math.PI) + 1) / 2;
			return wholeBadge(blend(BLUE_RGB, YELLOW_RGB, t), badge);
		},
	},
	{
		// Smooth cyan↔white shimmer.
		name: "cyan/white pulse  ",
		render: (badge, frame) => {
			const t = (Math.sin((frame / 24) * Math.PI) + 1) / 2;
			return wholeBadge(blend(CYAN_RGB, WHITE_RGB, t), badge);
		},
	},
	{
		// Whole word steps magenta → cyan → blue → back.
		name: "neon triad 120ms  ",
		render: (badge, frame) => {
			const colors = [NEON_MAGENTA, NEON_CYAN, NEON_BLUE];
			return wholeBadge(colors[Math.floor((frame * FRAME_INTERVAL_MS) / 120) % colors.length], badge);
		},
	},
	{
		// One bright white scanner sweeping across a dim cyan badge, KITT-style.
		name: "scanner sweep     ",
		render: (badge, frame) => {
			const characters = Array.from(badge);
			const span = characters.length;
			const cycle = span * 2 - 2;
			const step = Math.floor((frame * FRAME_INTERVAL_MS) / 40) % cycle;
			const position = step < span ? step : cycle - step;
			return characters
				.map((character, index) => {
					const distance = Math.abs(index - position);
					const color = distance === 0 ? BRIGHT_WHITE : distance === 1 ? NEON_CYAN : `${DIM}${NEON_BLUE}`;
					return `${BOLD}${color}${character}${RESET}`;
				})
				.join("");
		},
	},
	{
		// Smooth whole-word rainbow hue rotation.
		name: "rainbow cycle     ",
		render: (badge, frame) => wholeBadge(hue(frame, 9), badge),
	},
	{
		// Per-character rainbow, phase-shifted — a moving gradient.
		name: "rainbow gradient  ",
		render: (badge, frame) =>
			Array.from(badge)
				.map((character, index) => `${BOLD}${hue(frame + index * 4, 9)}${character}${RESET}`)
				.join(""),
	},
	{
		// Double-thump heartbeat: bright-bright-rest, like a pulse monitor.
		name: "heartbeat         ",
		render: (badge, frame) => {
			const ms = (frame * FRAME_INTERVAL_MS) % 1000;
			const bright = ms < 120 || (ms >= 220 && ms < 340);
			return wholeBadge(bright ? NEON_MAGENTA : `${DIM}${rgb(140, 0, 140)}`, badge);
		},
	},
	{
		// Starts as a fast magenta/cyan strobe and decays to a slow blink.
		name: "strobe decay      ",
		render: (badge, frame) => {
			const elapsed = frame * FRAME_INTERVAL_MS;
			const hold = Math.min(320, 40 + Math.floor(elapsed / 500) * 60);
			return wholeBadge(Math.floor(elapsed / hold) % 2 === 0 ? NEON_MAGENTA : NEON_CYAN, badge);
		},
	},
	{
		// Random characters glitch to random neon colors each frame.
		name: "glitch            ",
		render: (badge, frame) => {
			const step = Math.floor((frame * FRAME_INTERVAL_MS) / 60);
			const colors = [NEON_CYAN, NEON_MAGENTA, NEON_BLUE, BRIGHT_WHITE];
			return Array.from(badge)
				.map((character, index) => {
					const roll = jitter(step, index);
					const color = roll < 0.7 ? NEON_CYAN : colors[Math.floor(roll * 40) % colors.length];
					return `${BOLD}${color}${character}${RESET}`;
				})
				.join("");
		},
	},
	{
		// Mostly white with random cyan/magenta sparkles.
		name: "sparkle           ",
		render: (badge, frame) => {
			const step = Math.floor((frame * FRAME_INTERVAL_MS) / 80);
			return Array.from(badge)
				.map((character, index) => {
					const roll = jitter(step, index);
					const color = roll > 0.85 ? NEON_MAGENTA : roll > 0.7 ? NEON_CYAN : WHITE;
					return `${BOLD}${color}${character}${RESET}`;
				})
				.join("");
		},
	},
	{
		// Fire flicker: whole word wobbles through yellow/orange/red.
		name: "fire flicker      ",
		render: (badge, frame) => {
			const step = Math.floor((frame * FRAME_INTERVAL_MS) / 60);
			const heat = 0.5 + 0.5 * jitter(step, 7);
			return wholeBadge(blend([255, 60, 0], [255, 220, 40], heat), badge);
		},
	},
	{
		// Gold shimmer: luxurious yellow↔white glint.
		name: "gold shimmer      ",
		render: (badge, frame) => {
			const t = (Math.sin((frame / 16) * Math.PI) + 1) / 2;
			return wholeBadge(blend([255, 180, 0], WHITE_RGB, t), badge);
		},
	},
	{
		// Emergency lights: hard blue/red cuts.
		name: "police 60ms       ",
		render: flash(rgb(0, 90, 255), rgb(255, 40, 40), 60),
	},
];

const rawPercent = process.argv[2] ?? "96";
const percent = Number(rawPercent);
// Only badges the real threshold can produce are worth previewing.
const minPercent = Math.round(CACHE_HIT_THRESHOLD * 100);
if (!Number.isFinite(percent) || percent < minPercent || percent > 100) {
	console.error(`Usage: scripts/demo-cache-flash-variants.ts [percentage from ${minPercent} to 100]`);
	process.exit(1);
}
if (!process.stdout.isTTY) {
	console.error("The variants demo requires an interactive terminal.");
	process.exit(1);
}

const badge = `⚡ ${percent}% CACHE`;
const summary =
	`${BLUE}claude-opus-4-5${RESET}${DIM} | ${RESET}` +
	`${WHITE}pi-extensions${RESET}${DIM}:${RESET}${CYAN}main${RESET}${DIM} | ${RESET}` +
	`${GREEN}63k${RESET}${DIM}/${RESET}${WHITE}200k${RESET}${DIM} | ${RESET}` +
	`${WHITE}\uec82${RESET} ${GREEN}91${RESET}${DIM}·${RESET}${YELLOW}53${RESET}${DIM}·${RESET}${ORANGE}23${RESET}` +
	` ${WHITE}\uec81${RESET} ${RED}7${RESET}`;

let frame = 0;
let renderedLines = 0;

function draw(): void {
	const lines = VARIANTS.map(
		(variant) => `${DIM}${variant.name}${RESET} ${summary}${DIM} | ${RESET}${variant.render(badge, frame)}`,
	);
	if (renderedLines > 0) process.stdout.write(`\x1b[${renderedLines}A`);
	process.stdout.write(lines.map((line) => `\r\x1b[2K${line}`).join("\n"));
	process.stdout.write("\n");
	renderedLines = lines.length;
}

process.stdout.write("\x1b[?25l");
const timer = setInterval(() => {
	frame++;
	draw();
}, FRAME_INTERVAL_MS);

function cleanup(): void {
	clearInterval(timer);
	process.stdout.write("\x1b[?25h\n");
	process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

console.log(`${DIM}Cache celebration variants — Ctrl+C to exit. Edit VARIANTS in scripts/demo-cache-flash-variants.ts to iterate.${RESET}\n`);
draw();
