import type { Provider } from "@earendil-works/pi-ai";
import { aliasDisplayName, aliasEntryId, isValidAliasSuffix, type AliasEntry } from "./config.js";

/**
 * Registering a second provider id gives Pi a second auth.json credential slot.
 * Transport and model catalog still come from the source provider, so an alias
 * follows the host Pi version instead of duplicating its OAuth or API
 * implementation. The catalog is snapshotted at clone time; the source provider
 * remains the sole owner of any dynamic catalog refresh state.
 */
export function createAliasProvider(source: Provider, entry: AliasEntry): Provider {
	const oauth = source.auth?.oauth;
	if (!oauth) throw new Error(`provider "${source.id}" does not offer OAuth authentication`);

	const id = aliasEntryId(entry);
	const name = aliasDisplayName(entry, source.name);
	const models = source.getModels().map((model) => ({ ...model, provider: id }));

	return {
		...source,
		id,
		name,
		auth: { oauth: { ...oauth, name } },
		getModels: () => models,
		refreshModels: undefined,
	};
}

interface AliasAdoptionInput {
	/** Credential ids present in auth.json. */
	credentialIds: readonly string[];
	/** Every provider id the runtime knows, alias or not. */
	providerIds: readonly string[];
	/** Provider ids that can act as an alias base (they expose `auth.oauth`). */
	oauthProviderIds: readonly string[];
	/** Aliases already configured; never re-adopted. */
	existing?: readonly AliasEntry[];
}

/**
 * Recover aliases from credentials written by an earlier owner of the provider
 * id (originally pi-auto-permissions' built-in `openai-codex-auto-permissions`).
 *
 * The base is the *longest* OAuth provider id the credential extends, which is
 * what keeps `openai-codex-auto-permissions` attached to `openai-codex` rather
 * than to `openai`.
 */
export function adoptAliasesFromCredentials(input: AliasAdoptionInput): AliasEntry[] {
	const providerIds = new Set(input.providerIds);
	const taken = new Set((input.existing ?? []).map(aliasEntryId));
	const bases = [...input.oauthProviderIds].sort((a, b) => b.length - a.length);

	const adopted: AliasEntry[] = [];
	for (const credentialId of input.credentialIds) {
		if (providerIds.has(credentialId) || taken.has(credentialId)) continue;
		const base = bases.find((candidate) => credentialId.startsWith(`${candidate}-`));
		if (!base) continue;
		const suffix = credentialId.slice(base.length + 1);
		if (!isValidAliasSuffix(suffix)) continue;
		taken.add(credentialId);
		adopted.push({ base, suffix });
	}
	return adopted;
}
