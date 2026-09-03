import assert from "node:assert/strict";
import test from "node:test";
import { CelebrationPreview, PREVIEW_PERCENT, trackSelectedLabel } from "../celebration-preview.ts";
import {
	cacheBadgeText,
	CELEBRATION_STYLE_NAMES,
	CELEBRATION_STYLES,
	DEFAULT_CELEBRATION_STYLE,
	isCelebrationStyleName,
	parseFg,
	renderCacheBadge,
} from "../celebration-styles.ts";
import { STATUSLINE_THEMES } from "../themes.ts";

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
const PALETTE = STATUSLINE_THEMES.default;

test("every style preserves the badge text on every frame", () => {
	const badge = cacheBadgeText(96);
	assert.equal(badge, "\u26a196%\u00b7CACHE\u00b7HIT");

	for (const style of CELEBRATION_STYLE_NAMES) {
		for (let frame = 0; frame < 40; frame++) {
			const rendered = renderCacheBadge(96, frame, style, PALETTE);
			assert.equal(stripAnsi(rendered), badge, `${style} frame ${frame} text`);
			assert.ok(rendered.startsWith("\x1b[1m"), `${style} frame ${frame} is bold`);
			assert.ok(rendered.endsWith("\x1b[0m"), `${style} frame ${frame} resets`);
			assert.doesNotMatch(rendered, /\x1b\[38;2;(?:\d+;){2}\d+m\x1b\[0m$/, `${style} emits no trailing empty run`);
		}
	}
});

test("styles are deterministic, and every one of them actually animates", () => {
	for (const style of CELEBRATION_STYLE_NAMES) {
		for (const frame of [0, 7, 23]) {
			assert.equal(
				renderCacheBadge(96, frame, style, PALETTE),
				renderCacheBadge(96, frame, style, PALETTE),
				`${style} frame ${frame} is a pure function`,
			);
		}
		const frames = new Set(
			Array.from({ length: 24 }, (_, frame) => renderCacheBadge(96, frame, style, PALETTE)),
		);
		assert.ok(frames.size > 1, `${style} must change over time`);
	}
});

test("flash stays byte-identical to the pre-styles animation", () => {
	// The two-frame neon alternation that shipped before styles existed.
	assert.equal(DEFAULT_CELEBRATION_STYLE, "flash");
	assert.equal(renderCacheBadge(96, 0, "flash", PALETTE), "\x1b[1m\x1b[38;2;255;0;255m\u26a196%\u00b7CACHE\u00b7HIT\x1b[0m");
	assert.equal(renderCacheBadge(96, 1, "flash", PALETTE), "\x1b[1m\x1b[38;2;0;255;255m\u26a196%\u00b7CACHE\u00b7HIT\x1b[0m");
	assert.equal(renderCacheBadge(96, 2, "flash", PALETTE), renderCacheBadge(96, 0, "flash", PALETTE));
});

test("an unknown or hostile style falls back instead of throwing", () => {
	const fallback = renderCacheBadge(96, 3, "flash", PALETTE);
	assert.equal(renderCacheBadge(96, 3, "disco", PALETTE), fallback);
	assert.equal(renderCacheBadge(96, 3, "__proto__", PALETTE), fallback);
	assert.ok(isCelebrationStyleName("wave"));
	assert.ok(!isCelebrationStyleName("disco"));

	// Frames arrive from a timer, so out-of-range values must not produce escapes.
	for (const frame of [-5, 1.7, Number.NaN]) {
		for (const style of CELEBRATION_STYLE_NAMES) {
			const rendered = renderCacheBadge(96, frame, style, PALETTE);
			assert.equal(stripAnsi(rendered), cacheBadgeText(96), `${style} frame ${frame}`);
			assert.doesNotMatch(rendered, /NaN|-\d/, `${style} frame ${frame} emitted a bad channel`);
		}
	}
});

test("styles honour the palette, and the white theme stays greyscale", () => {
	for (const style of CELEBRATION_STYLE_NAMES) {
		if (style === "rainbow") continue; // full spectrum by design
		for (let frame = 0; frame < 12; frame++) {
			const rendered = renderCacheBadge(96, frame, style, STATUSLINE_THEMES.white);
			for (const [, r, g, b] of rendered.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)) {
				assert.equal(r, g, `${style} frame ${frame} is not grey`);
				assert.equal(g, b, `${style} frame ${frame} is not grey`);
			}
		}
	}

	// Rainbow is the documented exception.
	const rainbow = renderCacheBadge(96, 0, "rainbow", STATUSLINE_THEMES.white);
	assert.ok(/\x1b\[38;2;255;0;0m/.test(rainbow), "rainbow ignores the palette");

	// Theme changes must reach the badge.
	assert.notEqual(
		renderCacheBadge(96, 0, "wave", STATUSLINE_THEMES.default),
		renderCacheBadge(96, 0, "wave", STATUSLINE_THEMES.dracula),
	);
});

test("parseFg round-trips true colour and degrades safely", () => {
	assert.deepEqual(parseFg("\x1b[38;2;12;34;56m"), { r: 12, g: 34, b: 56 });
	assert.deepEqual(parseFg("\x1b[2m"), { r: 255, g: 255, b: 255 }, "the dim attribute is not a colour");
	assert.deepEqual(parseFg("nonsense"), { r: 255, g: 255, b: 255 });

	// Styles must survive a palette whose dim role is an attribute, not a colour.
	const odd = { ...PALETTE, celebration: ["\x1b[2m", "\x1b[2m"] as const };
	for (const style of CELEBRATION_STYLE_NAMES) {
		assert.equal(stripAnsi(CELEBRATION_STYLES[style](cacheBadgeText(96), 4, odd)), cacheBadgeText(96), style);
	}
});

test("the preview loops forever and only repaints on real transitions", () => {
	let renders = 0;
	let tick: (() => void) | undefined;
	const preview = new CelebrationPreview(() => renders++, {
		schedule: (callback) => {
			tick = callback;
			return 1;
		},
		cancel: () => {
			tick = undefined;
		},
	});

	assert.equal(preview.snapshot(), undefined, "nothing renders before it starts");
	assert.equal(preview.isRunning(), false);

	preview.setActive(true);
	assert.equal(renders, 1);
	assert.deepEqual(preview.snapshot(), { percent: PREVIEW_PERCENT, frame: 0 });

	preview.setActive(true);
	assert.equal(renders, 1, "staying on the row must not repaint or restart");
	assert.deepEqual(preview.snapshot(), { percent: PREVIEW_PERCENT, frame: 0 });

	tick?.();
	tick?.();
	assert.deepEqual(preview.snapshot(), { percent: PREVIEW_PERCENT, frame: 2 });
	assert.equal(renders, 3);

	// Unlike the real celebration this has no duration; it never self-cancels.
	for (let i = 0; i < 500; i++) tick?.();
	assert.equal(preview.snapshot()?.frame, 502);

	preview.setActive(false);
	assert.equal(preview.snapshot(), undefined, "leaving the row clears the badge");
	assert.equal(tick, undefined, "and stops the timer");
	const afterStop = renders;
	preview.setActive(false);
	assert.equal(renders, afterStop, "a second stop is silent");

	preview.setActive(true);
	assert.equal(preview.snapshot()?.frame, 0, "re-entering restarts the animation");
	preview.dispose();
	assert.equal(preview.snapshot(), undefined);
	assert.equal(renders, afterStop + 1, "dispose never repaints");
});

test("trackSelectedLabel reports the highlighted row from the render pass", () => {
	const base = {
		label: (text: string, selected: boolean) => (selected ? `>${text}` : ` ${text}`),
		value: (text: string) => text,
		description: (text: string) => text,
		cursor: "> ",
		hint: (text: string) => text,
	};
	const tracked = trackSelectedLabel(base);

	tracked.begin();
	assert.equal(tracked.selected(), undefined);
	assert.equal(tracked.theme.label("Theme        ", false), " Theme        ", "wrapping preserves the theme output");
	tracked.theme.label("Cache celebration   ", true);
	tracked.theme.label("Worktree root ", false);
	assert.equal(tracked.selected(), "Cache celebration", "padding is trimmed");

	// A pass that draws no selected row (a submenu is open) must not go stale.
	tracked.begin();
	tracked.theme.label("Repo aliases", false);
	assert.equal(tracked.selected(), undefined);
});
