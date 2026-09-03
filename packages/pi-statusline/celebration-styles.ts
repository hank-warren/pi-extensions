/**
 * Cache-hit badge animations.
 *
 * Every style is a pure `(frame, palette) -> string[]` colouring of the badge
 * characters, so a style can be rendered for any frame in any order. That keeps
 * them testable, and lets the settings menu loop a preview without touching the
 * real celebration timer.
 */
import type { StatuslinePalette } from "./themes.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

interface Rgb {
	r: number;
	g: number;
	b: number;
}

const fgCode = ({ r, g, b }: Rgb): string =>
	`\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(b)}m`;

/** Parse an SGR true-colour prefix back into channels; anything else reads as white. */
export function parseFg(code: string): Rgb {
	const match = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(code);
	if (!match) return { r: 255, g: 255, b: 255 };
	return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({
	r: a.r + (b.r - a.r) * t,
	g: a.g + (b.g - a.g) * t,
	b: a.b + (b.b - a.b) * t,
});

const scale = ({ r, g, b }: Rgb, factor: number): Rgb => ({
	r: Math.min(255, r * factor),
	g: Math.min(255, g * factor),
	b: Math.min(255, b * factor),
});

/** Deterministic per-(index, frame) noise; no Math.random so frames are reproducible. */
function noise(index: number, frame: number): number {
	const x = Math.sin(index * 127.1 + frame * 311.7) * 43758.5453;
	return x - Math.floor(x);
}

function hue(degrees: number): Rgb {
	const h = (((degrees % 360) + 360) % 360) / 60;
	const sector = Math.floor(h);
	const f = h - sector;
	const q = 255 * (1 - f);
	const t = 255 * f;
	switch (sector) {
		case 0:
			return { r: 255, g: t, b: 0 };
		case 1:
			return { r: q, g: 255, b: 0 };
		case 2:
			return { r: 0, g: 255, b: t };
		case 3:
			return { r: 0, g: q, b: 255 };
		case 4:
			return { r: t, g: 0, b: 255 };
		default:
			return { r: 255, g: 0, b: q };
	}
}

/** Colour every character of `badge` for one frame. */
type CelebrationStyle = (badge: string, frame: number, palette: StatuslinePalette) => string;

const uniform = (badge: string, colour: Rgb): string => `${BOLD}${fgCode(colour)}${badge}${RESET}`;

const perCharacter = (badge: string, colourAt: (index: number) => Rgb): string => {
	const chars = [...badge];
	let out = BOLD;
	let previous = "";
	for (const [index, char] of chars.entries()) {
		const code = fgCode(colourAt(index));
		if (code !== previous) {
			out += code;
			previous = code;
		}
		out += char;
	}
	return out + RESET;
};

/** The original two-frame alternation. */
const flash: CelebrationStyle = (badge, frame, palette) =>
	uniform(badge, parseFg(palette.celebration[frame % 2 === 0 ? 0 : 1]));

/** A bright crest sweeping left to right, trailing back into the base colour. */
const wave: CelebrationStyle = (badge, frame, palette) => {
	const base = parseFg(palette.celebration[0]);
	const crest = parseFg(palette.celebration[1]);
	const length = [...badge].length;
	const period = length + 6;
	const position = (frame % period) - 3;
	return perCharacter(badge, (index) => {
		const distance = Math.abs(index - position);
		const intensity = Math.max(0, 1 - distance / 3);
		return scale(mix(base, crest, intensity), 1 + intensity * 0.35);
	});
};

/** Whole badge ramping between dim and bright on a triangle wave. */
const pulse: CelebrationStyle = (badge, frame, palette) => {
	const base = parseFg(palette.celebration[0]);
	const peak = parseFg(palette.celebration[1]);
	const period = 20;
	const phase = (frame % period) / period;
	const triangle = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
	return uniform(badge, scale(mix(scale(base, 0.45), peak, triangle), 1 + triangle * 0.25));
};

/** Full spectrum rotating along the badge; ignores the theme by design. */
const rainbow: CelebrationStyle = (badge, frame) =>
	perCharacter(badge, (index) => hue(index * 18 - frame * 12));

/** Random characters flare to the highlight colour and decay back. */
const sparkle: CelebrationStyle = (badge, frame, palette) => {
	const base = parseFg(palette.celebration[0]);
	const spark = parseFg(palette.celebration[1]);
	return perCharacter(badge, (index) => {
		const intensity = Math.max(noise(index, frame) ** 6, noise(index, frame - 1) ** 6 * 0.5);
		return scale(mix(base, spark, intensity), 1 + intensity * 0.5);
	});
};

export const CELEBRATION_STYLES = { flash, wave, pulse, rainbow, sparkle } as const;

export type CelebrationStyleName = keyof typeof CELEBRATION_STYLES;

export const DEFAULT_CELEBRATION_STYLE: CelebrationStyleName = "flash";
export const CELEBRATION_STYLE_NAMES = Object.keys(CELEBRATION_STYLES) as CelebrationStyleName[];

export function isCelebrationStyleName(value: unknown): value is CelebrationStyleName {
	// hasOwn, not `in`: "__proto__" and "toString" are on the prototype chain.
	return typeof value === "string" && Object.hasOwn(CELEBRATION_STYLES, value);
}

/** Format the badge text for a hit percentage. */
export const cacheBadgeText = (percent: number): string => `\u26a1${percent}%\u00b7CACHE\u00b7HIT`;

/** Render one animation frame of the cache badge. */
export function renderCacheBadge(
	percent: number,
	frame: number,
	style: string,
	palette: StatuslinePalette,
): string {
	const chosen = isCelebrationStyleName(style) ? style : DEFAULT_CELEBRATION_STYLE;
	// Math.max(0, NaN) is NaN, which would reach the SGR channels verbatim.
	const safeFrame = Number.isFinite(frame) ? Math.max(0, Math.trunc(frame)) : 0;
	return CELEBRATION_STYLES[chosen](cacheBadgeText(percent), safeFrame, palette);
}
