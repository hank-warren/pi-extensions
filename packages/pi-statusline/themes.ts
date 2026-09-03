/**
 * Statusline colour palettes. Every role is a full SGR prefix so a theme can use
 * a true-colour value, a plain attribute (`\x1b[2m`), or both.
 */
export interface StatuslinePalette {
	/** Active model id. */
	model: string;
	/** Provider id of the active model. */
	provider: string;
	/** Repository and directory names. */
	path: string;
	/** Git branch names. */
	branch: string;
	/** Neutral figures: the context window total and the usage provider icons. */
	text: string;
	/** Separators, the session id, and unknown values. */
	dim: string;
	/** Healthy: low context use, high remaining usage, an open PR. */
	ok: string;
	/** First warning step, and the dirty-checkout marker. */
	warn: string;
	/** Second warning step, and the commits-behind marker. */
	caution: string;
	/** Exhausted: high context use, low remaining usage, a closed PR. */
	danger: string;
	/** Merged pull requests. */
	accent: string;
	/** The two colours the cache-hit badge alternates between. */
	celebration: readonly [string, string];
}

const rgb = (hex: string): string => {
	const value = Number.parseInt(hex.slice(1), 16);
	return `\x1b[38;2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}m`;
};

/** The palette this package shipped before themes existed. */
const DEFAULT: StatuslinePalette = {
	model: rgb("#0099ff"),
	provider: rgb("#7aa2c8"),
	path: rgb("#dcdcdc"),
	branch: rgb("#56b6c2"),
	text: rgb("#dcdcdc"),
	dim: "\x1b[2m",
	ok: rgb("#00af50"),
	warn: rgb("#e6c800"),
	caution: rgb("#ffb055"),
	danger: rgb("#ff5555"),
	accent: rgb("#be78ff"),
	celebration: [rgb("#ff00ff"), rgb("#00ffff")],
};

/** Dracula, with the pink branch colour from Hank's Herdr sidebar config. */
const DRACULA: StatuslinePalette = {
	model: rgb("#bd93f9"),
	provider: rgb("#9580c9"),
	path: rgb("#f8f8f2"),
	branch: rgb("#ff79c6"),
	text: rgb("#f8f8f2"),
	dim: rgb("#6272a4"),
	ok: rgb("#50fa7b"),
	warn: rgb("#f1fa8c"),
	caution: rgb("#ffb86c"),
	danger: rgb("#ff5555"),
	accent: rgb("#8be9fd"),
	celebration: [rgb("#ff79c6"), rgb("#8be9fd")],
};

const GITHUB_DARK: StatuslinePalette = {
	model: rgb("#58a6ff"),
	provider: rgb("#6e8bb5"),
	path: rgb("#c9d1d9"),
	branch: rgb("#39c5cf"),
	text: rgb("#c9d1d9"),
	dim: rgb("#8b949e"),
	ok: rgb("#3fb950"),
	warn: rgb("#d29922"),
	caution: rgb("#db6d28"),
	danger: rgb("#f85149"),
	accent: rgb("#bc8cff"),
	celebration: [rgb("#bc8cff"), rgb("#39c5cf")],
};

const CATPPUCCIN_MOCHA: StatuslinePalette = {
	model: rgb("#cba6f7"),
	provider: rgb("#a58fc4"),
	path: rgb("#cdd6f4"),
	branch: rgb("#89dceb"),
	text: rgb("#cdd6f4"),
	dim: rgb("#6c7086"),
	ok: rgb("#a6e3a1"),
	warn: rgb("#f9e2af"),
	caution: rgb("#fab387"),
	danger: rgb("#f38ba8"),
	accent: rgb("#f5c2e7"),
	celebration: [rgb("#cba6f7"), rgb("#89dceb")],
};

/** No colour at all: white text, dimmed punctuation, a grey badge flash. */
const WHITE: StatuslinePalette = {
	model: rgb("#ffffff"),
	provider: rgb("#ffffff"),
	path: rgb("#ffffff"),
	branch: rgb("#ffffff"),
	text: rgb("#ffffff"),
	dim: "\x1b[2m",
	ok: rgb("#ffffff"),
	warn: rgb("#ffffff"),
	caution: rgb("#ffffff"),
	danger: rgb("#ffffff"),
	accent: rgb("#ffffff"),
	celebration: [rgb("#ffffff"), rgb("#888888")],
};

export const STATUSLINE_THEMES = {
	default: DEFAULT,
	dracula: DRACULA,
	"github-dark": GITHUB_DARK,
	"catppuccin-mocha": CATPPUCCIN_MOCHA,
	white: WHITE,
} as const satisfies Record<string, StatuslinePalette>;

export type StatuslineThemeName = keyof typeof STATUSLINE_THEMES;

export const DEFAULT_THEME: StatuslineThemeName = "default";
export const THEME_NAMES = Object.keys(STATUSLINE_THEMES) as StatuslineThemeName[];

export function isThemeName(value: unknown): value is StatuslineThemeName {
	// hasOwn, not `in`: "__proto__" and "toString" are on the prototype chain.
	return typeof value === "string" && Object.hasOwn(STATUSLINE_THEMES, value);
}

/** Resolve a theme name to its palette; anything unknown falls back to the default. */
export function resolvePalette(name: string): StatuslinePalette {
	return isThemeName(name) ? STATUSLINE_THEMES[name] : STATUSLINE_THEMES[DEFAULT_THEME];
}
