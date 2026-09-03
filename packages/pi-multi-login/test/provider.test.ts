import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { adoptAliasesFromCredentials, createAliasProvider } from "../provider.ts";

/** Providers Pi ships an OAuth login for, as of the pinned pi-ai. */
const OAUTH_PROVIDER_IDS = [
	"anthropic",
	"github-copilot",
	"kimi-coding",
	"openai-codex",
	"openrouter",
	"radius",
	"xai",
];

describe("alias provider clone", () => {
	test("takes the alias identity while retaining the base catalog and OAuth flow", () => {
		const source = openaiCodexProvider();
		const provider = createAliasProvider(source, { base: "openai-codex", suffix: "auto-permissions" });

		assert.equal(provider.id, "openai-codex-auto-permissions");
		assert.equal(provider.name, `${source.name} (auto-permissions)`);
		assert.equal(provider.auth.apiKey, undefined);
		assert.equal(provider.auth.oauth?.name, provider.name);
		assert.equal(provider.auth.oauth?.login, source.auth.oauth?.login);
		assert.equal(provider.auth.oauth?.refresh, source.auth.oauth?.refresh);
		assert.equal(provider.auth.oauth?.toAuth, source.auth.oauth?.toAuth);
		assert.equal(provider.stream, source.stream);
		assert.equal(provider.streamSimple, source.streamSimple);
		assert.equal(provider.refreshModels, undefined);

		assert.deepEqual(
			provider.getModels().map((model) => model.id),
			source.getModels().map((model) => model.id),
		);
		assert.ok(provider.getModels().every((model) => model.provider === "openai-codex-auto-permissions"));
	});

	test("does not mutate the source provider", () => {
		const source = openaiCodexProvider();
		createAliasProvider(source, { base: "openai-codex", suffix: "alternate" });

		assert.equal(source.id, "openai-codex");
		assert.equal(source.auth.oauth?.name, openaiCodexProvider().auth.oauth?.name);
		assert.ok(source.getModels().every((model) => model.provider === "openai-codex"));
	});

	test("uses an explicit name when the config supplies one", () => {
		const provider = createAliasProvider(anthropicProvider(), {
			base: "anthropic",
			suffix: "work",
			name: "Anthropic (work)",
		});

		assert.equal(provider.id, "anthropic-work");
		assert.equal(provider.name, "Anthropic (work)");
		assert.equal(provider.auth.oauth?.name, "Anthropic (work)");
	});

	test("rejects a base provider without an OAuth login", () => {
		const source = { ...openaiCodexProvider(), id: "no-oauth", auth: {} } as unknown as Provider;
		assert.throws(
			() => createAliasProvider(source, { base: "no-oauth", suffix: "alt" }),
			/does not offer OAuth authentication/,
		);
	});
});

describe("credential adoption", () => {
	const providerIds = getBuiltinProviders();

	test("adopts only credentials that extend an OAuth provider id", () => {
		const adopted = adoptAliasesFromCredentials({
			credentialIds: ["anthropic", "openai-codex", "xai", "openai-codex-auto-permissions"],
			providerIds,
			oauthProviderIds: OAUTH_PROVIDER_IDS,
		});

		// Longest match wins: `openai` is also a provider id and also a prefix.
		assert.deepEqual(adopted, [{ base: "openai-codex", suffix: "auto-permissions" }]);
	});

	test("never adopts a credential that is itself a provider id", () => {
		assert.deepEqual(
			adoptAliasesFromCredentials({
				credentialIds: [...providerIds],
				providerIds,
				oauthProviderIds: OAUTH_PROVIDER_IDS,
			}),
			[],
		);
	});

	test("does not adopt a credential whose base has no OAuth login", () => {
		assert.ok(providerIds.includes("google-vertex"));
		assert.deepEqual(
			adoptAliasesFromCredentials({
				credentialIds: ["google-vertex-foo"],
				providerIds,
				oauthProviderIds: OAUTH_PROVIDER_IDS,
			}),
			[],
		);
	});

	test("does not re-adopt an alias that is already configured", () => {
		assert.deepEqual(
			adoptAliasesFromCredentials({
				credentialIds: ["openai-codex-auto-permissions"],
				providerIds,
				oauthProviderIds: OAUTH_PROVIDER_IDS,
				existing: [{ base: "openai-codex", suffix: "auto-permissions" }],
			}),
			[],
		);
	});

	test("skips credentials whose suffix is not a valid slug", () => {
		assert.deepEqual(
			adoptAliasesFromCredentials({
				credentialIds: ["anthropic-Work", "anthropic--work", "anthropic-"],
				providerIds,
				oauthProviderIds: OAUTH_PROVIDER_IDS,
			}),
			[],
		);
	});
});
