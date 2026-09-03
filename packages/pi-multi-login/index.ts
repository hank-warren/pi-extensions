/**
 * pi-multi-login — register additional OAuth logins for Pi's built-in providers.
 *
 * Each alias is an ordinary provider whose id is `${base}-${suffix}`, so it gets
 * its own auth.json credential slot while reusing the base provider's OAuth
 * flow, transport and model catalog.
 *
 * Aliases register during the extension *load* phase, not at session_start:
 * `pi --list-models`, `pi --model provider/id` and `pi auth` all run before any
 * session exists, and a session-only registration is invisible to them. Load
 * phase registrations are queued and flushed before every extension's
 * session_start, so load order between extensions does not matter.
 */
import type { Provider } from "@earendil-works/pi-ai";
import {
	ModelRuntime,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	aliasDisplayName,
	aliasEntryId,
	aliasProviderId,
	isValidAliasSuffix,
	loadMultiLoginConfig,
	multiLoginConfigExists,
	multiLoginConfigPath,
	saveMultiLoginConfig,
	type AliasEntry,
} from "./config.js";
import { adoptAliasesFromCredentials, createAliasProvider } from "./provider.js";
import { removeAliasEntry } from "./removal.js";

const LOG_PREFIX = "[pi-multi-login]";
const ADD_LABEL = "Add a login…";
const CANCEL_LABEL = "Cancel";
const REMOVE_LABEL = "Remove";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default async function multiLogin(pi: ExtensionAPI): Promise<void> {
	const configPath = multiLoginConfigPath();
	let aliases: AliasEntry[] = [];
	let configError: string | undefined;
	let runtimePromise: Promise<ModelRuntime> | undefined;

	/**
	 * Provider discovery, credential listing and logout all resolve from a
	 * runtime's own registry, so the package keeps a runtime of its own rather
	 * than reaching into the session's. It is created lazily: a host with no
	 * aliases pays nothing for the package.
	 */
	function sharedRuntime(): Promise<ModelRuntime> {
		runtimePromise ??= ModelRuntime.create({ allowModelNetwork: false });
		return runtimePromise;
	}

	function oauthProviders(runtime: ModelRuntime): Provider[] {
		return runtime.getProviders().filter((provider) => provider.auth?.oauth);
	}

	/**
	 * Register one alias with both the host and the package runtime. Returns a
	 * warning when the alias cannot be built; a bad entry never aborts the rest.
	 */
	function registerAlias(runtime: ModelRuntime, entry: AliasEntry): string | undefined {
		const id = aliasEntryId(entry);
		if (runtime.getProvider(id)) return `alias "${id}" collides with an existing provider id; skipped`;
		const source = runtime.getProvider(entry.base);
		if (!source) return `alias "${id}" has unknown base provider "${entry.base}"; skipped`;
		if (!source.auth?.oauth) return `alias "${id}" base provider "${entry.base}" has no OAuth login; skipped`;

		const clone = createAliasProvider(source, entry);
		runtime.registerNativeProvider(clone);
		pi.registerProvider(clone);
		return undefined;
	}

	try {
		if (multiLoginConfigExists(configPath)) {
			aliases = loadMultiLoginConfig(configPath).aliases;
		} else {
			// One-time adoption: credentials written before this package existed
			// (pi-auto-permissions' `openai-codex-auto-permissions`) become visible,
			// editable config instead of silently losing their provider. Writing the
			// file — even empty — is what stops this from running again.
			const runtime = await sharedRuntime();
			const oauthIds = oauthProviders(runtime).map((provider) => provider.id);
			aliases = adoptAliasesFromCredentials({
				credentialIds: (await runtime.listCredentials()).map((credential) => credential.providerId),
				providerIds: runtime.getProviders().map((provider) => provider.id),
				oauthProviderIds: oauthIds,
			});
			saveMultiLoginConfig({ aliases }, configPath);
		}
	} catch (error) {
		configError = `${configPath}: ${errorMessage(error)}`;
		aliases = [];
		console.error(`${LOG_PREFIX} ${configError}`);
	}

	if (aliases.length > 0) {
		const runtime = await sharedRuntime();
		for (const entry of aliases) {
			const warning = registerAlias(runtime, entry);
			if (warning) console.warn(`${LOG_PREFIX} ${warning}`);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (configError) {
			ctx.ui.notify(`pi-multi-login: ${configError}. No aliases were registered.`, "warning");
			return;
		}
		// Re-clone from the *composed* session provider: an alias of `anthropic`
		// must inherit whatever config overlay reshapes that provider's transport,
		// not the raw built-in. Re-registration is idempotent.
		for (const entry of aliases) {
			const source = ctx.modelRegistry.getProvider(entry.base);
			if (!source?.auth?.oauth) {
				console.warn(`${LOG_PREFIX} base provider "${entry.base}" is unavailable; ${aliasEntryId(entry)} was not refreshed.`);
				continue;
			}
			pi.registerProvider(createAliasProvider(source, entry));
		}
	});

	/**
	 * Authentication is deliberately not attempted here. Pi's own `/login` already
	 * lists every alias (they are ordinary providers) and implements every auth
	 * prompt type the OAuth flows can emit. A previous version drove the login
	 * dialog itself and broke the moment a flow emitted a `select` prompt — which
	 * OpenAI Codex now does — so the add flow registers the alias and hands off.
	 */
	function notifyLoginHandoff(ctx: ExtensionContext, id: string, name: string): void {
		ctx.ui.notify(`Added ${id}. Run /login and pick "${name}" to sign in.`, "info");
	}

	async function addAlias(ctx: ExtensionContext): Promise<void> {
		const runtime = await sharedRuntime();
		const aliasIds = new Set(aliases.map(aliasEntryId));
		const bases = oauthProviders(runtime)
			.filter((provider) => !aliasIds.has(provider.id))
			.sort((a, b) => a.id.localeCompare(b.id));
		if (bases.length === 0) {
			ctx.ui.notify("No OAuth providers are available to alias.", "warning");
			return;
		}

		const labels = bases.map((provider) => `${provider.id} — ${provider.name}`);
		const chosen = await ctx.ui.select("Base provider for the new login", labels);
		if (!chosen) return;
		const base = bases[labels.indexOf(chosen)];
		if (!base) return;

		const suffix = (await ctx.ui.input(`Suffix for the new ${base.id} login`, "work"))?.trim();
		if (!suffix) return;
		if (!isValidAliasSuffix(suffix)) {
			ctx.ui.notify(`"${suffix}" is not a valid suffix — use lowercase letters, digits and single dashes.`, "error");
			return;
		}

		const id = aliasProviderId(base.id, suffix);
		if (aliasIds.has(id) || runtime.getProvider(id)) {
			ctx.ui.notify(`Provider id "${id}" is already taken.`, "error");
			return;
		}

		const entry: AliasEntry = { base: base.id, suffix };
		const next = [...aliases, entry];
		try {
			saveMultiLoginConfig({ aliases: next }, configPath);
		} catch (error) {
			ctx.ui.notify(`Could not write ${configPath}: ${errorMessage(error)}`, "error");
			return;
		}
		aliases = next;

		const warning = registerAlias(runtime, entry);
		if (warning) {
			ctx.ui.notify(`pi-multi-login: ${warning}`, "error");
			return;
		}

		notifyLoginHandoff(ctx, id, aliasDisplayName(entry, base.name));
	}

	async function removeAlias(ctx: ExtensionContext, entry: AliasEntry): Promise<void> {
		const runtime = await sharedRuntime();
		const id = aliasEntryId(entry);
		// The ordering rules live in removal.ts, which is where they are tested.
		const result = await removeAliasEntry(id, aliases, configPath, {
			saveConfig: (remaining) => saveMultiLoginConfig({ aliases: remaining }, configPath),
			unregisterRuntimeProvider: (target) => runtime.unregisterProvider(target),
			unregisterSessionProvider: (target) => pi.unregisterProvider(target),
			logout: (target) => runtime.logout(target),
			notify: (message, level) => ctx.ui.notify(message, level),
		});
		aliases = result.aliases;
	}

	pi.registerCommand("multi-login", {
		description: "Add or remove an additional OAuth login; sign in with /login",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("/multi-login requires interactive TUI mode", "warning");
				return;
			}
			if (configError) {
				ctx.ui.notify(`pi-multi-login: ${configError}`, "error");
				return;
			}

			const runtime = await sharedRuntime();
			const stored = new Set((await runtime.listCredentials()).map((credential) => credential.providerId));
			const rows = aliases.map(
				(entry) =>
					`${aliasEntryId(entry)}  ${stored.has(aliasEntryId(entry)) ? "✓ stored" : "• not signed in — sign in via /login"}`,
			);
			const choice = await ctx.ui.select("Additional logins", [ADD_LABEL, ...rows]);
			if (!choice) return;
			if (choice === ADD_LABEL) {
				await addAlias(ctx);
				return;
			}

			const entry = aliases[rows.indexOf(choice)];
			if (!entry) return;
			const action = await ctx.ui.select(aliasEntryId(entry), [REMOVE_LABEL, CANCEL_LABEL]);
			if (action === REMOVE_LABEL) {
				await removeAlias(ctx, entry);
			}
		},
	});
}
