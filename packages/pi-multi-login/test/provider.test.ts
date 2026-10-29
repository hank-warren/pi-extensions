import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { adoptAliasesFromCredentials, createAliasProvider, hasLoginMethod } from "../provider.ts";

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

	test("rejects a base provider without any login", () => {
		const source = { ...openaiCodexProvider(), id: "no-login", auth: {} } as unknown as Provider;
		assert.equal(hasLoginMethod(source), false);
		assert.throws(
			() => createAliasProvider(source, { base: "no-login", suffix: "alt" }),
			/does not offer an OAuth or API-key login/,
		);
	});

	test("rejects a base whose API-key auth is ambient-only", () => {
		const base = openaiProvider();
		const { login: _login, ...ambient } = base.auth.apiKey ?? { name: "x", resolve: async () => undefined };
		const source = { ...base, id: "ambient", auth: { apiKey: ambient } } as Provider;
		assert.equal(hasLoginMethod(source), false);
		assert.throws(() => createAliasProvider(source, { base: "ambient", suffix: "alt" }));
	});
});

describe("alias API-key login", () => {
	const signal = AbortSignal.timeout(5_000);
	const ambientCtx = {
		env: async (name: string) => (name === "ANTHROPIC_API_KEY" || name === "OPENAI_API_KEY" ? "sk-ambient" : undefined),
		fileExists: async () => false,
	};

	test("keeps both OAuth and API-key logins when the base offers both", () => {
		const source = anthropicProvider();
		const provider = createAliasProvider(source, { base: "anthropic", suffix: "work" });

		assert.ok(provider.auth.oauth);
		assert.ok(provider.auth.apiKey);
		assert.equal(provider.auth.apiKey.login, source.auth.apiKey?.login);
		assert.equal(provider.auth.apiKey.name, `${provider.name} API key`);
	});

	test("aliases an API-key-only base", () => {
		const provider = createAliasProvider(openaiProvider(), { base: "openai", suffix: "work" });

		assert.equal(provider.id, "openai-work");
		assert.equal(provider.auth.oauth, undefined);
		assert.ok(provider.auth.apiKey?.login);
		assert.ok(provider.getModels().every((model) => model.provider === "openai-work"));
	});

	test("never resolves the base's ambient environment key", async () => {
		const source = anthropicProvider();
		const provider = createAliasProvider(source, { base: "anthropic", suffix: "work" });

		// The base itself does pick the ambient key up; the alias must not.
		assert.ok(await source.auth.apiKey?.resolve({ ctx: ambientCtx, signal }));
		assert.equal(await provider.auth.apiKey?.resolve({ ctx: ambientCtx, signal }), undefined);
		if (provider.auth.apiKey?.check) {
			assert.equal(await provider.auth.apiKey.check({ ctx: ambientCtx, signal }), undefined);
		}
	});

	test("resolves the alias's own stored key", async () => {
		const provider = createAliasProvider(anthropicProvider(), { base: "anthropic", suffix: "work" });
		const credential = { type: "api_key" as const, key: "sk-alias" };

		const result = await provider.auth.apiKey?.resolve({ ctx: ambientCtx, credential, signal });
		assert.equal(result?.auth.apiKey, "sk-alias");
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
