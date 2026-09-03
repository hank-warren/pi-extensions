import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatTokenCount, renderStatusline, type StatuslineData } from "../index.ts";
import { type BooleanSettingKey, defaultSettings } from "../settings.ts";
import { STATUSLINE_THEMES, THEME_NAMES } from "../themes.ts";

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");

test("formatTokenCount formats compact decimal token counts", () => {
	assert.equal(formatTokenCount(999), "999");
	assert.equal(formatTokenCount(1_000), "1k");
	assert.equal(formatTokenCount(1_500), "1.5k");
	assert.equal(formatTokenCount(40_000), "40k");
	assert.equal(formatTokenCount(1_000_000), "1.0m");
	assert.equal(formatTokenCount(1_250_000), "1.3m");
});

test("renderStatusline renders the requested two-line layout in the Claude HUD palette", () => {
	const lines = renderStatusline(
		{
			model: "gpt-5.6-sol",
			cwd: "pi-extensions",
			cwdGit: { branch: "main", dirty: false, behind: 0 },
			contextTokens: 40_000,
			contextWindow: 1_000_000,
			worktrees: [],
			sessionId: "019fafa7-29c0-7e99-9f82-5794d5721848",
		},
		120,
	);

	assert.deepEqual(lines.map(stripAnsi), [
		"gpt-5.6-sol | pi-extensions:main | 40k/1.0m",
		"019fafa7-29c0-7e99-9f82-5794d5721848",
	]);
	assert.equal(
		lines[0],
		"\x1b[38;2;0;153;255mgpt-5.6-sol\x1b[0m\x1b[2m | \x1b[0m" +
			"\x1b[38;2;220;220;220mpi-extensions\x1b[0m\x1b[2m:\x1b[0m" +
			"\x1b[38;2;86;182;194mmain\x1b[0m\x1b[2m | \x1b[0m" +
			"\x1b[38;2;0;175;80m40k\x1b[0m\x1b[2m/\x1b[0m\x1b[38;2;220;220;220m1.0m\x1b[0m",
	);
	assert.equal(lines[1], "\x1b[2m019fafa7-29c0-7e99-9f82-5794d5721848\x1b[0m");
});

test("renderStatusline appends the neon cache module and animates only its badge", () => {
	const data = {
		model: "gpt-5.6-sol",
		cwd: "pi-extensions",
		cwdGit: { branch: "main", dirty: false, behind: 0 },
		contextTokens: 40_000,
		contextWindow: 1_000_000,
		worktrees: [
			{
				path: "/worktree",
				repo: "pi-extensions",
				branch: "feat/cache-wave",
				dirty: false,
				behind: 0,
				pr: 45,
				prState: "OPEN" as const,
			},
		],
		sessionId: "session-id",
	};
	const normal = renderStatusline(data, 160);
	const frame0 = renderStatusline({ ...data, cacheCelebration: { percent: 96, frame: 0 } }, 160);
	const frame1 = renderStatusline({ ...data, cacheCelebration: { percent: 96, frame: 1 } }, 160);
	const frame2 = renderStatusline({ ...data, cacheCelebration: { percent: 96, frame: 2 } }, 160);
	const separator = "\x1b[2m | \x1b[0m";
	const animatedPrefixLength = normal[0].length + separator.length;

	assert.equal(
		stripAnsi(frame0[0]),
		"gpt-5.6-sol | pi-extensions:main | 40k/1.0m | ⚡96%·CACHE·HIT",
	);
	assert.equal(frame0[0].slice(0, normal[0].length), normal[0]);
	assert.equal(frame0[0].slice(normal[0].length, animatedPrefixLength), separator);
	assert.equal(frame0[0].slice(0, animatedPrefixLength), frame1[0].slice(0, animatedPrefixLength));
	// Whole badge flashes as one color: magenta on even frames, cyan on odd.
	assert.equal(
		frame0[0].slice(animatedPrefixLength),
		"\x1b[1m\x1b[38;2;255;0;255m⚡96%·CACHE·HIT\x1b[0m",
	);
	assert.equal(
		frame1[0].slice(animatedPrefixLength),
		"\x1b[1m\x1b[38;2;0;255;255m⚡96%·CACHE·HIT\x1b[0m",
	);
	assert.notEqual(frame0[0], frame1[0]);
	assert.equal(frame0[0], frame2[0]);
	assert.deepEqual(frame0.slice(1), normal.slice(1));
	assert.deepEqual(frame1.slice(1), normal.slice(1));
});

test("cache celebration rendering remains ANSI-width safe at narrow widths", () => {
	for (const width of [0, 1, 8, 12, 20, 40]) {
		const lines = renderStatusline(
			{
				model: "model",
				cwd: "repo",
				cwdGit: { branch: "main", dirty: false, behind: 0 },
				contextTokens: 1_000,
				contextWindow: 10_000,
				worktrees: [],
				sessionId: "session",
				cacheCelebration: { percent: 96, frame: 7 },
			},
			width,
		);
		assert.equal(lines.length, 2);
		for (const line of lines) assert.ok(visibleWidth(line) <= width);
	}

	const firstLine = renderStatusline(
		{
			model: "model",
			cwd: "repo",
			cwdGit: null,
			contextTokens: 1_000,
			contextWindow: 10_000,
			worktrees: [],
			sessionId: "session",
			cacheCelebration: { percent: 96, frame: 0 },
		},
		80,
	)[0];
	assert.ok(stripAnsi(firstLine).endsWith("1k/10k | ⚡96%·CACHE·HIT"));
});

test("renderStatusline uses Claude HUD context warning thresholds", () => {
	const colors = [
		[499_999, "\x1b[38;2;0;175;80m"],
		[500_000, "\x1b[38;2;255;176;85m"],
		[700_000, "\x1b[38;2;230;200;0m"],
		[900_000, "\x1b[38;2;255;85;85m"],
	] as const;

	for (const [contextTokens, color] of colors) {
		const line = renderStatusline(
			{
				model: "model",
				cwd: "repo",
				cwdGit: { branch: "main", dirty: false, behind: 0 },
				contextTokens,
				contextWindow: 1_000_000,
				worktrees: [],
				sessionId: "session",
			},
			80,
		)[0];
		assert.ok(line.includes(`${color}${formatTokenCount(contextTokens)}\x1b[0m`));
	}
});

test("renderStatusline inserts touched worktrees and pull requests before the session", () => {
	const lines = renderStatusline(
		{
			model: "gpt-5.6-sol",
			cwd: "pi-extensions",
			cwdGit: { branch: "main", dirty: true, behind: 1 },
			contextTokens: 40_000,
			contextWindow: 1_000_000,
			worktrees: [
				{
					path: "/home/hank/repos/worktrees/feature-statusline",
					repo: "pi-extensions",
					branch: "feature/statusline",
					dirty: true,
					behind: 2,
					pr: 7,
					prState: "OPEN",
				},
				{
					path: "/home/hank/repos/worktrees/fix-alerts",
					repo: "infrastructure",
					branch: "fix/alerts",
					dirty: false,
					behind: 0,
					pr: 168,
					prState: "OPEN",
				},
			],
			sessionId: "019fafa7-29c0-7e99-9f82-5794d5721848",
		},
		160,
	);

	assert.deepEqual(lines.map(stripAnsi), [
		"gpt-5.6-sol | pi-extensions:main* ⇣1 | 40k/1.0m",
		"⑂ pi-extensions:feature/statusline* ⇣2 #7 | infrastructure:fix/alerts #168",
		"019fafa7-29c0-7e99-9f82-5794d5721848",
	]);
	assert.match(
		lines[1],
		/^\x1b\[2m⑂\x1b\[0m \x1b\[38;2;220;220;220mpi-extensions\x1b\[0m\x1b\[2m:\x1b\[0m\x1b\[38;2;86;182;194mfeature\/statusline\x1b\[0m\x1b\[38;2;230;200;0m\*\x1b\[0m \x1b\[38;2;255;176;85m⇣2\x1b\[0m \x1b\[38;2;0;175;80m#7\x1b\[0m/,
	);
});

test("renderStatusline marks unknown context usage and respects narrow widths", () => {
	for (const width of [0, 1, 8, 20]) {
		const lines = renderStatusline(
			{
				model: "gpt-5.6-sol",
				cwd: "pi-extensions",
				cwdGit: { branch: "feature/a-very-long-main-branch", dirty: true, behind: 123 },
				contextTokens: null,
				contextWindow: 1_000_000,
				worktrees: [
					{
						path: "/worktree",
						repo: "repository",
						branch: "feature/a-very-long-branch",
						dirty: true,
						behind: 99,
						pr: 123,
						prState: "OPEN",
					},
				],
				sessionId: "019fafa7-29c0-7e99-9f82-5794d5721848",
			},
			width,
		);

		assert.equal(lines.length, 3);
		for (const line of lines) assert.ok(visibleWidth(line) <= width);
	}

	const summary = renderStatusline(
		{
			model: "model",
			cwd: "repo",
			cwdGit: null,
			contextTokens: null,
			contextWindow: 1_000_000,
			worktrees: [],
			sessionId: "session",
		},
		80,
	)[0];
	assert.match(stripAnsi(summary), /\?\/1\.0m$/);
});

const GATED_DATA: StatuslineData = {
	model: "gpt-5.6-sol",
	provider: "anthropic-team",
	cwd: "pi-extensions",
	cwdGit: { branch: "main", dirty: false, behind: 0 },
	contextTokens: 40_000,
	contextWindow: 1_000_000,
	worktrees: [
		{ path: "/wt", repo: "infrastructure", branch: "fix/alerts", dirty: false, behind: 0, pr: 9, prState: "OPEN" },
	],
	sessionId: "session-id",
	usage: { codex: { weekly: 80 } },
};

test("each disabled element removes exactly its segment, never a stray separator", () => {
	const settings = defaultSettings("/home/hank");
	const full = renderStatusline(GATED_DATA, 160, settings).map(stripAnsi);
	assert.deepEqual(full, [
		"gpt-5.6-sol | pi-extensions:main | 40k/1.0m | \uec81 80",
		"⑂ infrastructure:fix/alerts #9",
		"session-id",
	]);

	const expected: Record<BooleanSettingKey, string[]> = {
		showModel: ["pi-extensions:main | 40k/1.0m | \uec81 80", "⑂ infrastructure:fix/alerts #9", "session-id"],
		// Off by default, so disabling it is a no-op — the enabling tests below cover it.
		showProvider: full,
		showDirectory: ["gpt-5.6-sol | 40k/1.0m | \uec81 80", "⑂ infrastructure:fix/alerts #9", "session-id"],
		showContext: ["gpt-5.6-sol | pi-extensions:main | \uec81 80", "⑂ infrastructure:fix/alerts #9", "session-id"],
		showUsage: ["gpt-5.6-sol | pi-extensions:main | 40k/1.0m", "⑂ infrastructure:fix/alerts #9", "session-id"],
		showWorktrees: ["gpt-5.6-sol | pi-extensions:main | 40k/1.0m | \uec81 80", "session-id"],
		showSessionId: [
			"gpt-5.6-sol | pi-extensions:main | 40k/1.0m | \uec81 80",
			"⑂ infrastructure:fix/alerts #9",
		],
		showCacheCelebration: full,
	};

	for (const [key, lines] of Object.entries(expected) as [BooleanSettingKey, string[]][]) {
		const rendered = renderStatusline(GATED_DATA, 160, { ...settings, [key]: false }).map(stripAnsi);
		assert.deepEqual(rendered, lines, key);
		for (const line of rendered) {
			assert.doesNotMatch(line, /^\s*\|/, `${key} leaves a leading separator`);
			assert.doesNotMatch(line, /\|\s*$/, `${key} leaves a trailing separator`);
		}
	}
});

test("the provider segment is opt-in and sits between the model and the directory", () => {
	const settings = defaultSettings("/home/hank");

	assert.equal(
		stripAnsi(renderStatusline(GATED_DATA, 160, settings)[0]),
		"gpt-5.6-sol | pi-extensions:main | 40k/1.0m | \uec81 80",
		"a provider in the data changes nothing until the setting is on",
	);

	const on = renderStatusline(GATED_DATA, 160, { ...settings, showProvider: true });
	assert.equal(
		stripAnsi(on[0]),
		"gpt-5.6-sol | anthropic-team | pi-extensions:main | 40k/1.0m | \uec81 80",
	);
	assert.ok(
		on[0].includes(`\x1b[2m | \x1b[0m\x1b[38;2;122;162;200manthropic-team\x1b[0m\x1b[2m | \x1b[0m`),
		"the provider gets its own palette role, not the model's",
	);
});

test("a missing provider drops the segment instead of leaving a separator", () => {
	const settings = { ...defaultSettings("/home/hank"), showProvider: true };
	const off = renderStatusline(GATED_DATA, 160, { ...settings, showProvider: false });

	for (const provider of [undefined, ""]) {
		const rendered = renderStatusline({ ...GATED_DATA, provider }, 160, settings);
		assert.deepEqual(rendered, off, `provider ${JSON.stringify(provider)} renders as if disabled`);
		for (const line of rendered.map(stripAnsi)) {
			assert.doesNotMatch(line, /^\s*\|/, "leading separator");
			assert.doesNotMatch(line, /\|\s*$/, "trailing separator");
		}
	}
});

test("the model and provider toggles are independent", () => {
	const settings = defaultSettings("/home/hank");
	const line = stripAnsi(
		renderStatusline(GATED_DATA, 160, { ...settings, showModel: false, showProvider: true })[0],
	);

	assert.equal(line, "anthropic-team | pi-extensions:main | 40k/1.0m | \uec81 80");
	assert.doesNotMatch(line, /^\s*\|/);
});

test("disabling every element still renders one stable footer row", () => {
	const settings = defaultSettings("/home/hank");
	const off = { ...settings } as ReturnType<typeof defaultSettings>;
	for (const key of [
		"showModel",
		"showProvider",
		"showDirectory",
		"showContext",
		"showUsage",
		"showWorktrees",
		"showSessionId",
		"showCacheCelebration",
	] as BooleanSettingKey[]) {
		off[key] = false;
	}
	assert.deepEqual(renderStatusline(GATED_DATA, 160, off), [""]);
	assert.deepEqual(renderStatusline(GATED_DATA, 0, off), [""]);
});

test("line counts shrink cleanly from three rows to one", () => {
	const settings = defaultSettings("/home/hank");
	const counts = [
		[settings, 3],
		[{ ...settings, showWorktrees: false }, 2],
		[{ ...settings, showWorktrees: false, showSessionId: false }, 1],
	] as const;

	for (const [candidate, expected] of counts) {
		assert.equal(renderStatusline(GATED_DATA, 160, candidate).length, expected);
		assert.equal(renderStatusline(GATED_DATA, 0, candidate).length, expected, "width 0 keeps the row count");
	}
});

test("the cache celebration is gated and never orphaned on a badge-only line", () => {
	const settings = defaultSettings("/home/hank");
	const data = { ...GATED_DATA, cacheCelebration: { percent: 96, frame: 0 } };

	assert.match(stripAnsi(renderStatusline(data, 160, settings)[0]), /⚡96%·CACHE·HIT$/);
	assert.doesNotMatch(
		stripAnsi(renderStatusline(data, 160, { ...settings, showCacheCelebration: false })[0]),
		/CACHE/,
	);

	const noSummary = {
		...settings,
		showModel: false,
		showDirectory: false,
		showContext: false,
		showUsage: false,
		showWorktrees: false,
	};
	assert.deepEqual(renderStatusline(data, 160, noSummary).map(stripAnsi), ["session-id"]);
});

test("themes recolour every element without changing the rendered text", () => {
	// showProvider is opt-in, so the theme sweep has to enable it to cover its role.
	const settings = { ...defaultSettings("/home/hank"), showProvider: true };
	const data = { ...GATED_DATA, cacheCelebration: { percent: 96, frame: 0 } };
	const plain = renderStatusline(data, 160, settings).map(stripAnsi);
	const seen = new Set<string>();

	for (const theme of THEME_NAMES) {
		const lines = renderStatusline(data, 160, { ...settings, theme });
		assert.deepEqual(lines.map(stripAnsi), plain, `${theme} must not change the text`);
		assert.equal(seen.has(lines.join("\n")), false, `${theme} must differ from every other theme`);
		seen.add(lines.join("\n"));

		const palette = STATUSLINE_THEMES[theme];
		assert.ok(lines[0].startsWith(palette.model), `${theme} colours the model`);
		assert.ok(lines[0].includes(palette.provider), `${theme} colours the provider`);
		assert.ok(lines[0].includes(palette.branch), `${theme} colours the branch`);
		assert.ok(lines[2].startsWith(palette.dim), `${theme} dims the session id`);
		assert.ok(lines[0].includes(palette.celebration[0]), `${theme} colours the cache badge`);
		assert.ok(
			renderStatusline({ ...data, cacheCelebration: { percent: 96, frame: 1 } }, 160, {
				...settings,
				theme,
			})[0].includes(palette.celebration[1]),
			`${theme} alternates the badge colour`,
		);
	}

	// An unknown theme must render, not crash or blank out.
	assert.deepEqual(
		renderStatusline(data, 160, { ...settings, theme: "bogus" as never }),
		renderStatusline(data, 160, settings),
	);
});

test("the default theme is byte-identical to the pre-theme palette", () => {
	const settings = defaultSettings("/home/hank");
	const line = renderStatusline(GATED_DATA, 160, settings)[0];
	assert.ok(line.startsWith("\x1b[38;2;0;153;255mgpt-5.6-sol\x1b[0m\x1b[2m | \x1b[0m"));
	assert.ok(line.includes("\x1b[38;2;86;182;194mmain\x1b[0m"));
	assert.ok(line.includes("\x1b[38;2;0;175;80m40k\x1b[0m"));
});

test("worktree repo names honour configured aliases", () => {
	const settings = defaultSettings("/home/hank");
	assert.equal(
		stripAnsi(renderStatusline(GATED_DATA, 160, settings)[1]),
		"⑂ infrastructure:fix/alerts #9",
		"aliases are empty by default",
	);
	assert.equal(
		stripAnsi(renderStatusline(GATED_DATA, 160, { ...settings, repoAliases: { infrastructure: "infra" } })[1]),
		"⑂ infra:fix/alerts #9",
	);
});
