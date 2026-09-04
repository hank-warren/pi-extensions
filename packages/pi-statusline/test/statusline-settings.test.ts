import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ADD_ALIAS_VALUE,
	aliasItems,
	aliasSummary,
	applySettingChange,
	BOOLEAN_ROWS,
	buildSettingItems,
	CACHE_CELEBRATION_ID,
	CACHE_CELEBRATION_LABEL,
	celebrationValue,
	CUSTOM_ITEMS_ID,
	parseAliasEntry,
	REPO_ALIASES_ID,
	THEME_ID,
	WORKTREE_ROOT_ID,
} from "../settings-menu.ts";
import { CELEBRATION_STYLE_NAMES } from "../celebration-styles.ts";
import { DEFAULT_THEME, isThemeName, resolvePalette, STATUSLINE_THEMES, THEME_NAMES } from "../themes.ts";
import { normalizeCustomItems } from "../custom.ts";
import {
	type BooleanSettingKey,
	BOOLEAN_SETTING_KEYS,
	changedSettingKeys,
	collapseHome,
	defaultSettings,
	defaultSettingsPath,
	expandHome,
	normalizeSettings,
	repoAlias,
	resolveWorktreeRoot,
	serializeSettings,
	SETTING_KEYS,
	type SettingKey,
	SettingsStore,
	type StatuslineSettings,
} from "../settings.ts";

const HOME = "/home/hank";

async function settingsFixture(): Promise<{ root: string; path: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-statusline-settings-"));
	return { root, path: join(root, "agent", "statusline-settings.json") };
}

/**
 * The unconfigured store follows PI_CODING_AGENT_DIR.
 *
 * `defaultSettingsPath` used to join the *home* dir with ".pi/agent", so a
 * session running against another agent dir saved `/statusline` settings into
 * the host's real one. `home` still shapes the settings' content (worktree root,
 * `~` collapsing), which is why it stays a separate parameter.
 */
test("the default settings path follows the agent dir, not the home dir", async () => {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	assert.ok(agentDir, "the hermetic preload set an agent dir");
	assert.equal(defaultSettingsPath(), join(agentDir, "statusline-settings.json"));
	assert.notEqual(
		defaultSettingsPath(),
		join(homedir(), ".pi", "agent", "statusline-settings.json"),
		"the agent dir is what is followed, not ~/.pi/agent",
	);

	const store = new SettingsStore({ home: HOME });
	assert.equal(store.getPath(), join(agentDir, "statusline-settings.json"));
	await store.save({ ...defaultSettings(HOME), showUsage: false }, ["showUsage"]);
	assert.deepEqual(JSON.parse(await readFile(store.getPath(), "utf8")), { showUsage: false });
});

test("defaults are the pre-settings behaviour, minus the hardcoded aliases", () => {
	const defaults = defaultSettings(HOME);
	// Spelled out per key rather than "all true": a new toggle has to be classified
	// here instead of inheriting an assumption that every element ships enabled.
	const expected: Record<BooleanSettingKey, boolean> = {
		showModel: true,
		showProvider: false,
		showDirectory: true,
		showContext: true,
		showUsage: true,
		// On, but inert: the default item list is empty, so nothing is spawned.
		showCustomItems: true,
		showWorktrees: true,
		showSessionId: true,
		showCacheCelebration: true,
	};
	for (const key of BOOLEAN_SETTING_KEYS) assert.equal(defaults[key], expected[key], key);
	assert.equal(defaults.worktreeRoot, "/home/hank/repos/worktrees");
	assert.deepEqual(defaults.repoAliases, {});
	assert.deepEqual(defaults.customItems, []);
	assert.equal(defaults.theme, "default");
});

test("every theme defines a complete palette and unknown names fall back", () => {
	assert.deepEqual(THEME_NAMES, ["default", "dracula", "github-dark", "catppuccin-mocha", "white"]);
	assert.equal(DEFAULT_THEME, "default");

	const roles = Object.keys(STATUSLINE_THEMES.default);
	for (const name of THEME_NAMES) {
		const palette = STATUSLINE_THEMES[name];
		assert.deepEqual(Object.keys(palette), roles, `${name} palette shape`);
		for (const [role, value] of Object.entries(palette)) {
			const codes = role === "celebration" ? (value as readonly string[]) : [value as string];
			assert.equal(codes.length, role === "celebration" ? 2 : 1, `${name}.${role}`);
			for (const code of codes) assert.match(code, /^\x1b\[(38;2;\d+;\d+;\d+|2)m$/, `${name}.${role}`);
		}
		// The badge must alternate, or the celebration stops animating.
		assert.notEqual(palette.celebration[0], palette.celebration[1], `${name} celebration frames`);
	}

	assert.ok(isThemeName("dracula"));
	assert.ok(!isThemeName("nope"));
	assert.ok(!isThemeName("__proto__"), "prototype keys are not themes");
	assert.equal(resolvePalette("nope"), STATUSLINE_THEMES.default);
	assert.equal(resolvePalette("__proto__"), STATUSLINE_THEMES.default);
	assert.equal(resolvePalette("dracula"), STATUSLINE_THEMES.dracula);
});

test("the dracula theme uses the branch pink from the Herdr sidebar config", () => {
	const dracula = STATUSLINE_THEMES.dracula;
	assert.equal(dracula.branch, "\x1b[38;2;255;121;198m", "#ff79c6");
	assert.equal(dracula.caution, "\x1b[38;2;255;184;108m", "#ffb86c");

	// "White" means exactly one visible colour plus the dim attribute.
	const white = STATUSLINE_THEMES.white;
	const { dim, celebration, ...colours } = white;
	assert.equal(dim, "\x1b[2m");
	assert.deepEqual(new Set(Object.values(colours)), new Set(["\x1b[38;2;255;255;255m"]));
	assert.equal(celebration[0], "\x1b[38;2;255;255;255m");
});

test("a missing or malformed settings file yields defaults", async (t) => {
	const fixture = await settingsFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));

	const missing = new SettingsStore({ path: fixture.path, home: HOME });
	assert.deepEqual(await missing.load(), defaultSettings(HOME));

	await missing.save(defaultSettings(HOME));
	await writeFile(fixture.path, "{ not json");
	const malformed = new SettingsStore({ path: fixture.path, home: HOME });
	assert.deepEqual(await malformed.load(), defaultSettings(HOME));
});

test("one wrong-typed key falls back alone without discarding valid siblings", () => {
	const { settings } = normalizeSettings(
		{
			showModel: "nope",
			showContext: false,
			worktreeRoot: 7,
			repoAliases: { frontend: "fe", broken: 3 },
			theme: "not-a-theme",
		},
		HOME,
	);
	assert.equal(settings.theme, "default", "an unknown theme falls back without touching siblings");

	assert.equal(settings.showModel, true, "invalid value falls back to its own default");
	assert.equal(settings.showContext, false, "valid siblings survive");
	assert.equal(settings.worktreeRoot, "/home/hank/repos/worktrees");
	assert.deepEqual(settings.repoAliases, { frontend: "fe" });
});

test("writes are sparse and preserve unknown top-level keys", async (t) => {
	const fixture = await settingsFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));

	const defaults = defaultSettings(HOME);
	assert.deepEqual(serializeSettings(defaults, {}, HOME), {}, "an untouched config serialises to nothing");
	assert.deepEqual(serializeSettings({ ...defaults, showUsage: false }, {}, HOME), { showUsage: false });

	const store = new SettingsStore({ path: fixture.path, home: HOME });
	await store.save({ ...defaults, showWorktrees: false, repoAliases: { frontend: "fe" } });
	assert.deepEqual(JSON.parse(await readFile(fixture.path, "utf8")), {
		showWorktrees: false,
		repoAliases: { frontend: "fe" },
	});

	await writeFile(
		fixture.path,
		JSON.stringify({ showUsage: false, futureKey: { nested: true }, anotherFuture: 3 }),
	);
	const reloaded = new SettingsStore({ path: fixture.path, home: HOME });
	const loaded = await reloaded.load();
	assert.equal(loaded.showUsage, false);
	await reloaded.save({ ...loaded, showModel: false });
	assert.deepEqual(JSON.parse(await readFile(fixture.path, "utf8")), {
		futureKey: { nested: true },
		anotherFuture: 3,
		showModel: false,
		showUsage: false,
	});
});

test("saving is atomic and leaves no temp file behind on failure", async (t) => {
	const fixture = await settingsFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));

	const store = new SettingsStore({ path: fixture.path, home: HOME });
	await store.save({ ...defaultSettings(HOME), showModel: false });
	const directory = join(fixture.root, "agent");
	assert.deepEqual(await readdir(directory), ["statusline-settings.json"], "the temp file is renamed, not left");

	// A directory in the target's place makes the rename — and only the rename — fail.
	const blocked = join(fixture.root, "blocked");
	const blockedStore = new SettingsStore({ path: join(blocked, "statusline-settings.json"), home: HOME });
	await mkdir(join(blocked, "statusline-settings.json"), { recursive: true });
	await assert.rejects(() => blockedStore.save({ ...defaultSettings(HOME), showContext: false }));
	assert.deepEqual(await readdir(blocked), ["statusline-settings.json"], "no partial temp file survives");
	assert.equal(JSON.parse(await readFile(fixture.path, "utf8")).showContext, undefined);
});

test("worktree root input is ~-expanded and must be absolute", () => {
	assert.equal(expandHome("~/repos/trees", HOME), "/home/hank/repos/trees");
	assert.equal(expandHome("$HOME/repos/trees", HOME), "/home/hank/repos/trees");
	assert.equal(expandHome("/srv/trees", HOME), "/srv/trees");
	assert.equal(collapseHome("/home/hank/repos/trees", HOME), "~/repos/trees");
	assert.equal(collapseHome("/srv/trees", HOME), "/srv/trees");

	assert.deepEqual(resolveWorktreeRoot("~/repos/trees/", HOME), { path: "/home/hank/repos/trees" });
	assert.match(resolveWorktreeRoot("repos/trees", HOME).error ?? "", /absolute/);
	assert.equal(resolveWorktreeRoot("repos/trees", HOME).path, undefined);

	const settings = { ...defaultSettings(HOME), worktreeRoot: "/srv/trees" };
	const rejected = applySettingChange(settings, WORKTREE_ROOT_ID, "relative/path", HOME);
	assert.equal(rejected.kind, "error");
	assert.equal(settings.worktreeRoot, "/srv/trees", "the previous value is kept");
});

test("repoAlias is the identity until an explicit alias is configured", () => {
	assert.equal(repoAlias("infrastructure"), "infrastructure", "an empty map is the identity");
	assert.equal(repoAlias("platform-api"), "platform-api", "no prefix rules are applied");
	assert.equal(repoAlias("frontend", {}), "frontend");
	assert.equal(repoAlias("frontend", { frontend: "fe" }), "fe");
	assert.equal(repoAlias("platform-api", { "platform-api": "api" }), "api");
	assert.equal(repoAlias("pi-extensions", { frontend: "fe" }), "pi-extensions");
});

test("buildSettingItems mirrors the settings object", () => {
	const settings: StatuslineSettings = {
		...defaultSettings(HOME),
		showUsage: false,
		showSessionId: false,
		theme: "dracula",
		cacheCelebrationStyle: "wave",
		worktreeRoot: "/home/hank/code/trees",
		repoAliases: { frontend: "fe" },
	};
	const items = buildSettingItems(settings, {}, HOME);

	assert.deepEqual(
		items.map((item) => item.id),
		[
			THEME_ID,
			"showModel",
			"showProvider",
			"showDirectory",
			"showContext",
			"showUsage",
			CACHE_CELEBRATION_ID,
			"showCustomItems",
			"showWorktrees",
			"showSessionId",
			WORKTREE_ROOT_ID,
			REPO_ALIASES_ID,
			CUSTOM_ITEMS_ID,
		],
		"rows follow the order their elements render in",
	);
	assert.equal(
		items.findIndex((item) => item.id === CACHE_CELEBRATION_ID) -
			items.findIndex((item) => item.id === "showUsage"),
		1,
		"the badge is appended after the usage meters, so its row follows them",
	);
	assert.deepEqual(
		items.map((item) => item.label),
		[
			"Theme",
			"Model",
			"Provider",
			"Directory & git",
			"Context",
			"Subscription usage",
			CACHE_CELEBRATION_LABEL,
			"Custom items",
			"Worktree line",
			"Session ID line",
			"Worktree root",
			"Repo aliases",
			"Custom item list",
		],
	);
	assert.deepEqual(
		items.map((item) => item.currentValue),
		[
			"dracula",
			"on",
			"off",
			"on",
			"on",
			"off",
			"wave",
			"on",
			"on",
			"off",
			"~/code/trees",
			"1 alias",
			"none configured",
		],
	);
	assert.deepEqual(items[0]?.values, [...THEME_NAMES], "Enter cycles through every theme");
	assert.deepEqual(
		items.find((item) => item.id === CACHE_CELEBRATION_ID)?.values,
		["off", ...CELEBRATION_STYLE_NAMES],
		"the celebration row folds off into the style list",
	);
	assert.equal(
		celebrationValue({ ...settings, showCacheCelebration: false }),
		"off",
		"a disabled celebration reads as off, whatever style is stored",
	);
	for (const row of BOOLEAN_ROWS) {
		assert.deepEqual(items.find((item) => item.id === row.id)?.values, ["on", "off"]);
	}
	assert.equal(items.at(-1)?.submenu, undefined, "submenus are injected, not assumed");

	assert.equal(aliasSummary({ ...settings, repoAliases: {} }), "0 aliases");
	assert.equal(aliasSummary({ ...settings, repoAliases: { a: "1", b: "2" } }), "2 aliases");
});

test("applySettingChange maps every row to its field", () => {
	const settings = defaultSettings(HOME);
	for (const row of BOOLEAN_ROWS) {
		const off = applySettingChange(settings, row.id, "off", HOME);
		assert.equal(off.kind, "settings");
		if (off.kind !== "settings") return;
		assert.equal(off.settings[row.id], false);
		for (const other of BOOLEAN_ROWS) {
			if (other.id !== row.id) {
				assert.equal(off.settings[other.id], settings[other.id], `${row.id} must not touch ${other.id}`);
			}
		}
		const on = applySettingChange(off.settings, row.id, "on", HOME);
		assert.equal(on.kind === "settings" && on.settings[row.id], true);
	}

	assert.equal(applySettingChange(settings, "showModel", "maybe", HOME).kind, "error");

	const theme = applySettingChange(settings, THEME_ID, "github-dark", HOME);
	assert.equal(theme.kind === "settings" && theme.settings.theme, "github-dark");
	assert.equal(applySettingChange(settings, THEME_ID, "default", HOME).kind, "ignored");
	assert.equal(applySettingChange(settings, THEME_ID, "nope", HOME).kind, "error");

	// The one celebration row drives two fields.
	const off = applySettingChange(settings, CACHE_CELEBRATION_ID, "off", HOME);
	assert.equal(off.kind === "settings" && off.settings.showCacheCelebration, false);
	assert.equal(
		off.kind === "settings" && off.settings.cacheCelebrationStyle,
		"flash",
		"turning it off preserves the chosen style for when it comes back",
	);
	const wave = applySettingChange(settings, CACHE_CELEBRATION_ID, "wave", HOME);
	assert.equal(wave.kind === "settings" && wave.settings.showCacheCelebration, true);
	assert.equal(wave.kind === "settings" && wave.settings.cacheCelebrationStyle, "wave");
	assert.equal(applySettingChange(settings, CACHE_CELEBRATION_ID, "flash", HOME).kind, "ignored");
	assert.equal(applySettingChange(settings, CACHE_CELEBRATION_ID, "disco", HOME).kind, "error");
	assert.equal(
		applySettingChange({ ...settings, showCacheCelebration: false }, CACHE_CELEBRATION_ID, "flash", HOME).kind,
		"settings",
		"re-selecting the stored style while off turns it back on",
	);

	const root = applySettingChange(settings, WORKTREE_ROOT_ID, "~/code/trees", HOME);
	assert.equal(root.kind === "settings" && root.settings.worktreeRoot, "/home/hank/code/trees");
	assert.equal(applySettingChange(settings, WORKTREE_ROOT_ID, "~/repos/worktrees", HOME).kind, "ignored");
	// Alias edits are committed by their submenu; its done() value is display text only.
	assert.equal(applySettingChange(settings, REPO_ALIASES_ID, "1 alias", HOME).kind, "ignored");
});

test("the alias submenu lists sorted pairs plus the add row", () => {
	const settings = { ...defaultSettings(HOME), repoAliases: { infrastructure: "infra", frontend: "fe" } };
	assert.deepEqual(
		aliasItems(settings).map((item) => [item.value, item.label]),
		[
			["frontend", "frontend → fe"],
			["infrastructure", "infrastructure → infra"],
			[ADD_ALIAS_VALUE, "Add alias…"],
		],
	);

	assert.deepEqual(parseAliasEntry("frontend=fe"), { repo: "frontend", alias: "fe" });
	assert.deepEqual(parseAliasEntry("  frontend → fe "), { repo: "frontend", alias: "fe" });
	assert.equal(parseAliasEntry("frontend"), undefined);
	assert.equal(parseAliasEntry("=fe"), undefined);
});

test("SETTING_KEYS stays exhaustive as settings are added", () => {
	// SETTING_KEYS drives changedSettingKeys, which drives every save. A key
	// missing from it applies live and then silently fails to persist, so this
	// is asserted at runtime as well as by the compile-time guard in settings.ts.
	assert.deepEqual(
		[...SETTING_KEYS].sort(),
		Object.keys(defaultSettings(HOME)).sort(),
		"add the new key to SETTING_KEYS (and to normalizeSettings + serializeSettings)",
	);

	// Every listed key must actually round-trip through the store's own diff.
	const defaults = defaultSettings(HOME);
	const changes: Record<SettingKey, StatuslineSettings> = {
		showModel: { ...defaults, showModel: false },
		// Off by default, so "differs from its default" means turning it on.
		showProvider: { ...defaults, showProvider: true },
		showDirectory: { ...defaults, showDirectory: false },
		showContext: { ...defaults, showContext: false },
		showUsage: { ...defaults, showUsage: false },
		showCustomItems: { ...defaults, showCustomItems: false },
		showWorktrees: { ...defaults, showWorktrees: false },
		showSessionId: { ...defaults, showSessionId: false },
		showCacheCelebration: { ...defaults, showCacheCelebration: false },
		theme: { ...defaults, theme: "dracula" },
		cacheCelebrationStyle: { ...defaults, cacheCelebrationStyle: "wave" },
		worktreeRoot: { ...defaults, worktreeRoot: "/tmp/trees" },
		repoAliases: { ...defaults, repoAliases: { a: "1" } },
		customItems: {
			...defaults,
			customItems: normalizeCustomItems([{ id: "clock", command: "date +%H:%M" }]),
		},
	};
	for (const key of SETTING_KEYS) {
		assert.deepEqual(changedSettingKeys(defaults, changes[key]), [key], `${key} is not diffed`);
		assert.ok(
			Object.hasOwn(serializeSettings(changes[key], {}, HOME), key),
			`${key} is not serialized once it differs from its default`,
		);
	}
});

test("changedSettingKeys reports exactly the fields one edit touched", () => {
	const base = defaultSettings(HOME);
	assert.deepEqual(changedSettingKeys(base, base), []);
	assert.deepEqual(changedSettingKeys(base, { ...base, theme: "dracula" }), ["theme"]);
	assert.deepEqual(changedSettingKeys(base, { ...base, showUsage: false }), ["showUsage"]);
	assert.deepEqual(
		changedSettingKeys(base, { ...base, showCacheCelebration: false, cacheCelebrationStyle: "wave" }),
		["showCacheCelebration", "cacheCelebrationStyle"],
		"the one celebration row can legitimately move two fields",
	);

	// Alias maps are compared by content, not identity.
	assert.deepEqual(changedSettingKeys(base, { ...base, repoAliases: {} }), []);
	assert.deepEqual(changedSettingKeys(base, { ...base, repoAliases: { a: "1" } }), ["repoAliases"]);
	const withAlias = { ...base, repoAliases: { a: "1" } };
	assert.deepEqual(changedSettingKeys(withAlias, { ...base, repoAliases: { a: "1" } }), []);
	assert.deepEqual(changedSettingKeys(withAlias, { ...base, repoAliases: { a: "2" } }), ["repoAliases"]);
	assert.deepEqual(changedSettingKeys(withAlias, { ...base, repoAliases: { a: "1", b: "2" } }), ["repoAliases"]);
});

test("a stale session saving one field cannot revert another writer's settings", async (t) => {
	const { root, path } = await settingsFixture();
	t.after(() => rm(root, { recursive: true, force: true }));

	// A session that started when the file was empty: defaults in memory.
	const stale = new SettingsStore({ home: HOME, path });
	assert.deepEqual((await stale.load()).repoAliases, {});

	// Meanwhile the user adds aliases by hand, and another session sets a theme.
	await mkdir(join(root, "agent"), { recursive: true });
	await writeFile(
		path,
		JSON.stringify({ repoAliases: { infrastructure: "infra" }, theme: "dracula", futureKey: 7 }),
	);

	// The stale session changes one unrelated toggle.
	const next = { ...stale.get(), showUsage: false };
	await stale.save(next, changedSettingKeys(stale.get(), next));

	const onDisk = JSON.parse(await readFile(path, "utf8"));
	assert.deepEqual(
		onDisk,
		{ repoAliases: { infrastructure: "infra" }, theme: "dracula", futureKey: 7, showUsage: false },
		"only the edited key is written; everything else survives untouched",
	);
});

test("a merging save removes a key that is back at its default", async (t) => {
	const { root, path } = await settingsFixture();
	t.after(() => rm(root, { recursive: true, force: true }));

	await mkdir(join(root, "agent"), { recursive: true });
	await writeFile(path, JSON.stringify({ theme: "dracula", repoAliases: { a: "1" } }));

	const store = new SettingsStore({ home: HOME, path });
	const loaded = await store.load();
	assert.equal(loaded.theme, "dracula");

	const next = { ...loaded, theme: DEFAULT_THEME };
	await store.save(next, changedSettingKeys(loaded, next));

	assert.deepEqual(
		JSON.parse(await readFile(path, "utf8")),
		{ repoAliases: { a: "1" } },
		"sparse output means a defaulted key is deleted, not written",
	);
});

test("a merging save still works when the file is missing or corrupt", async (t) => {
	const { root, path } = await settingsFixture();
	t.after(() => rm(root, { recursive: true, force: true }));

	const store = new SettingsStore({ home: HOME, path });
	const first = { ...(await store.load()), theme: "white" as const };
	await store.save(first, ["theme"]);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { theme: "white" });

	await writeFile(path, "{ not json");
	const second = { ...first, showModel: false };
	await store.save(second, ["showModel"]);
	assert.deepEqual(
		JSON.parse(await readFile(path, "utf8")),
		{ showModel: false },
		"unreadable content is discarded rather than propagated",
	);
});
