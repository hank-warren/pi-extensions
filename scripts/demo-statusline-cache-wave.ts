#!/usr/bin/env -S node --import tsx

import {
	CACHE_CELEBRATION_DURATION_MS,
	CACHE_CELEBRATION_FRAME_INTERVAL_MS,
	CACHE_HIT_THRESHOLD,
	CacheCelebrationController,
} from "../packages/pi-statusline/cache-celebration.ts";
import { renderStatusline, type StatuslineData } from "../packages/pi-statusline/index.ts";

const rawPercent = process.argv[2] ?? "96";
const percent = Number(rawPercent);
// Only badges the real threshold can produce are worth previewing.
const minPercent = Math.round(CACHE_HIT_THRESHOLD * 100);
if (!Number.isFinite(percent) || percent < minPercent || percent > 100) {
	console.error(`Usage: scripts/demo-statusline-cache-wave.ts [percentage from ${minPercent} to 100]`);
	process.exit(1);
}
if (!process.stdout.isTTY) {
	console.error("The cache-wave demo requires an interactive terminal.");
	process.exit(1);
}

const data: StatuslineData = {
	model: "gpt-5.6-sol",
	cwd: "pi-extensions",
	cwdGit: { branch: "feat/statusline-cache-wave", dirty: true, behind: 0 },
	contextTokens: 40_000,
	contextWindow: 1_000_000,
	worktrees: [
		{
			path: "/home/hank/repos/worktrees/statusline-cache-wave",
			repo: "pi-extensions",
			branch: "feat/statusline-cache-wave",
			dirty: true,
			behind: 0,
			pr: 45,
			prState: "OPEN",
		},
	],
	sessionId: "019fafa7-29c0-7e99-9f82-5794d5721848",
};

let renderedLines = 0;
let finished = false;
let controller: CacheCelebrationController;

function draw(): void {
	const width = Math.max(1, process.stdout.columns ?? 100);
	const lines = renderStatusline(
		{ ...data, cacheCelebration: controller.snapshot() },
		width,
	);
	if (renderedLines > 0) process.stdout.write(`\x1b[${renderedLines}A`);
	process.stdout.write(lines.map((line) => `\r\x1b[2K${line}`).join("\n"));
	process.stdout.write("\n");
	renderedLines = lines.length;
}

function cleanup(): void {
	if (finished) return;
	finished = true;
	controller.dispose();
	draw();
	process.stdout.write("\x1b[?25h");
}

function interrupted(signal: NodeJS.Signals): void {
	cleanup();
	process.exit(signal === "SIGINT" ? 130 : 143);
}

controller = new CacheCelebrationController(draw);
const onSigint = () => interrupted("SIGINT");
const onSigterm = () => interrupted("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);
process.stdout.write("\x1b[?25l");
controller.start(Math.round(percent));

try {
	await new Promise((resolve) =>
		setTimeout(
			resolve,
			CACHE_CELEBRATION_DURATION_MS + CACHE_CELEBRATION_FRAME_INTERVAL_MS * 2,
		),
	);
} finally {
	process.removeListener("SIGINT", onSigint);
	process.removeListener("SIGTERM", onSigterm);
	cleanup();
}

console.log(`Cache-wave demo complete (${Math.round(percent)}% hit).`);
