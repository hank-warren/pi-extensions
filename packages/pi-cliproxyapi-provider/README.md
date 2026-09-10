# pi-cliproxyapi-provider

> **Published fork.** This is `pi-cliproxyapi-provider` 0.15.23 (MIT, Richard Hao) as forked at
> [`hank-warren/pi-cliproxyapi-provider@3a4d021`](https://github.com/hank-warren/pi-cliproxyapi-provider/tree/3a4d021),
> six commits ahead of upstream [`0xRichardH/pi-cliproxyapi-provider`](https://github.com/0xRichardH/pi-cliproxyapi-provider):
> Anthropic Messages routing for Claude models, automatic refresh of stale models.dev metadata,
> and `xhigh`/`max` thinking levels derived from models.dev effort lists. The 4.7 MB bundled
> models.dev seed is gone; first-run metadata comes from pi's own built-in model catalog instead.
> Never install both this package and the upstream one at once, or the provider is registered twice.

`pi-cliproxyapi-provider` registers one [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance as a pi model provider. It discovers models from CLIProxyAPI's OpenAI-compatible `/v1/models` endpoint and enriches them with provider-specific metadata from [models.dev](https://models.dev/). Mixed catalogs use OpenAI Completions by default, while GPT-5.6 family models (including Codex variants) and GPT-6 models use the Responses API so pi can read their usage data, and Claude models use the Anthropic Messages API so signed thinking blocks and per-turn thinking effort survive a multi-turn conversation. Canonical `/v1/models` owners such as `openai` select the matching provider metadata; aliases can override that selection when a proxy routes billing differently.

## Install

```bash
pi install npm:@hank-warren/pi-cliproxyapi-provider
```

Restart pi after installing, then run:

```text
/cliproxyapi config
/login cpa
/model
```

To try it without installing, from a checkout of this repository:

```bash
CLIPROXYAPI_BASE_URL=http://localhost:8317/v1 \
CLIPROXYAPI_API_KEY=your-key \
pi -ne -e ./packages/pi-cliproxyapi-provider --list-models cpa
```

## Configure

Run the interactive command:

```text
/cliproxyapi config
```

It writes global connection/auth config to:

```text
~/.pi/agent/pi-cliproxyapi-provider/config.json
```

Environment variables override config:

```text
CLIPROXYAPI_BASE_URL
CLIPROXYAPI_PROVIDER_NAME
CLIPROXYAPI_AUTH_REQUIRED
CLIPROXYAPI_AUTH_HEADER
CLIPROXYAPI_MODELS_DEV_ENABLED
CLIPROXYAPI_METADATA_FALLBACK_PROVIDER
```

`CLIPROXYAPI_API_KEY` supplies the discovery credential for non-interactive runs. Set `CLIPROXYAPI_METADATA_FALLBACK_PROVIDER=none` to disable unresolved-model metadata fallback.

Project config supports `metadataFallbackProvider`, metadata aliases, and bounded per-model overrides. Set `metadataFallbackProvider` to `null` or `"none"` to disable fallback. Connection and auth settings such as `baseUrl`, `providerName`, `authRequired`, `authHeader`, and `headers` must be set in global config or environment variables.

### GPT-5.6 / GPT-6 context window

The provider advertises a `272000`-token context window for GPT-5.6 and GPT-6 models by default. This matches pi's conservative canonical limit, keeps compaction behaviour consistent with native model definitions, and avoids assuming that every CLIProxyAPI upstream account or route enables the provider's full long-context limit.

To opt into the full context limit reported by models.dev, add this package-specific setting to global `~/.pi/agent/settings.json`:

```json
{
  "pi-cliproxyapi-provider": {
    "gpt56ContextWindow": "full"
  }
}
```

The same setting can be placed in project `.pi/settings.json`; project settings override global settings. Supported values are:

- `"canonical"` (default): advertise `272000` tokens and compact at pi's conservative boundary.
- `"full"`: advertise the models.dev context limit, allowing pi to retain substantially more history before compaction.

Use `"full"` only when the selected CLIProxyAPI route and upstream account actually support that limit. Requests above `272000` input tokens also use the higher models.dev context-pricing tier where one is defined.

### Model and display configuration

Run `/cliproxyapi config` in pi's TUI to edit every package-level `settings.json` value. The tabbed panel has `Connection`, `Models`, and `Display` sections; it controls the GPT-5.6 context-window mode and whether the model selector shows the published strict tool-schema capability.

```json
{
  "pi-cliproxyapi-provider": {
    "gpt56ContextWindow": "canonical",
    "showStrictMode": false
  }
}
```

`showStrictMode` defaults to `false` because the selector stays compact for normal use. Enable it when diagnosing tool-schema behaviour; model details always show `Strict tool schema` explicitly. Saving through `/cliproxyapi config` reloads pi. Select `Connection` to open the endpoint and authentication editor.

## Authenticate

Use pi's normal API-key login flow:

```text
/login cpa
```

If you changed the provider name, use that name instead. For non-interactive runs, set:

```bash
export CLIPROXYAPI_API_KEY=your-key
```

## Commands

```text
/cliproxyapi config             # tabbed connection, model, and display configuration
/cliproxyapi config connection  # open endpoint and authentication editor
/cliproxyapi status             # show snapshots, capabilities, and enrichment counts
/cliproxyapi refresh            # refresh models and metadata, then update pi immediately
/cliproxyapi refresh models     # refresh CLIProxyAPI availability only
/cliproxyapi refresh metadata   # refresh models.dev metadata only
/cliproxyapi aliases            # show unmatched model IDs for metadata aliases
/cliproxyapi models             # inspect effective model settings and set bounded overrides
/cliproxyapi help               # show this list
```

## Thinking levels

Pi only offers the extended `xhigh` and `max` thinking levels when a model publishes a `thinkingLevelMap` that names them; without one, every reasoning model stops at `high`. CLIProxyAPI's `/v1/models` says nothing about effort, so the package takes the map from the metadata it already has: pi's built-in catalog publishes a finished `thinkingLevelMap` per model, and a models.dev entry that lacks one has its map derived from `reasoning_options` — each effort the provider accepts (`low` … `max`) maps to itself, and any pi level the provider does not accept maps to `null` so pi hides just that level. Claude Fable 5.x, Opus 4.7+ and Sonnet 5 therefore expose `xhigh` and `max`; Opus 4.6 exposes `max` but not `xhigh`; models described only with a thinking budget keep pi's default budget mapping.

`off` follows the same data. A `none` effort maps to it, a `toggle` option leaves it available, and a model with neither (Claude Fable 5.x) marks it `null`, because the upstream rejects `thinking.type = disabled` for those models. GPT-5.6 and GPT-6 keep their hand-written maps, which encode details models.dev lacks.

## Metadata aliases

Aliases affect metadata only. The package still sends the original CLIProxyAPI model ID to the proxy.

When `/v1/models` reports a canonical owner such as `openai`, the package uses that provider's metadata even if models.dev lists the model under several providers. Noncanonical owners can embed a provider hint, so `feedmob-opencode-go` resolves to `opencode-go` when that provider publishes the model. If ownership is still unresolved, the package uses OpenRouter metadata by default when there is exactly one matching OpenRouter entry. Set `metadataFallbackProvider` to another models.dev provider ID, or to `null`/`"none"` to disable this fallback. Add an alias when CLIProxyAPI's reported owner or fallback does not match the provider whose limits and pricing apply to your setup.

Add global aliases to:

```text
~/.pi/agent/pi-cliproxyapi-provider/config.json
```

Add project aliases manually to:

```text
.pi/pi-cliproxyapi-provider/config.json
```

Project config reads `metadataFallbackProvider`, `modelAliases`, and `modelOverrides`; other fields are ignored.

```json
{
  "metadataFallbackProvider": "openrouter",
  "modelAliases": {
    "claude-opus-4-6-thinking": "anthropic/claude-opus-4-6",
    "gpt-5.6-sol": "openai/gpt-5.6-sol"
  },
  "modelOverrides": {
    "gpt-5.6-sol": {
      "contextWindow": 512000,
      "maxTokens": 32768
    }
  }
}
```

## Model inspector and overrides

Run `/cliproxyapi models` in pi's TUI to inspect the models in the current CPA snapshot. The selector shows the effective API, reasoning mode, and context window. The detail view also shows input modalities, cost, thinking levels, and the compatibility values that pi will publish.

Only `reasoning`, `contextWindow`, and `maxTokens` are editable. Values are constrained to safe presets; choose `auto` to remove an override and restore the derived value after reload. API routing and compatibility stay provider-owned: GPT-5.6/GPT-6 Codex models remain on `openai-responses` and Claude models on `anthropic-messages`, while the CLIProxyAPI workaround publishes `supportsStrictMode: false`.

For CPA Responses requests, the extension also applies the Codex-compatible function-tool wire contract used by `pi-codex-conversion`: each function tool explicitly carries `strict: null`. This preserves optional tool arguments such as `interactive_shell.listBackground` without replacing CPA authentication, transport, discovery, or streaming with the ChatGPT-backed `openai-codex-responses` provider.

## Snapshots and startup

```text
CPA /v1/models:      local snapshot at startup, then a background refresh on every model discovery
models.dev metadata: persistent local snapshot, re-fetched in the background once it is a week old
first-run seed:      pi's own built-in model catalog, read in-process, no file and no network
```

Snapshots live under:

```text
~/.cache/pi-cliproxyapi-provider/
```

Startup registers the provider immediately from the last-known-good local snapshots and never fetches anything itself. With no metadata snapshot on disk it seeds from pi's built-in catalog, so a cold start already has real costs, context windows and thinking levels for the Anthropic, OpenAI, Codex, xAI, Google and OpenRouter models CLIProxyAPI usually fronts. On a first run with no CPA snapshot, pi registers a placeholder until background discovery succeeds.

Every model discovery pi triggers (startup, opening `/model`) re-checks CLIProxyAPI's model list, and **piggybacks a models.dev fetch when the metadata snapshot is stale**: either it is still the built-in seed, or the cached fetch is more than seven days old. That is what keeps a newly listed model from rendering with pi's bare fallback metadata (16384 output tokens, text only, zero cost) until someone notices. A fresh snapshot is never re-fetched on its own, so the ~7 MB download stays rare. `/cliproxyapi status` flags a stale snapshot; `/cliproxyapi refresh metadata` forces the fetch now.

Manual refreshes update the running provider immediately; `/reload` is not required. Failed refreshes retain the last-known-good data independently for each source — a models.dev outage never blocks CLIProxyAPI model discovery.

## How metadata is sourced

CLIProxyAPI is the only source of *availability*: the package discovers models from `GET <baseUrl>/models` and never asks for Management API access, so no powerful management key is needed and the proxy stays the source of truth for what exists. That endpoint returns IDs and owners and nothing else, so everything pi needs — context window, output limit, reasoning flag, image support, cost, thinking levels — is enriched from a metadata catalog keyed by `<provider>/<model-id>`.

Two catalogs feed that enrichment, in this order:

1. **A cached models.dev snapshot** under `~/.cache/pi-cliproxyapi-provider/`, when one exists and carries source-provider identity. models.dev's *provider* catalog is used rather than its lab-level one, so provider-specific prices and context-pricing tiers are available.
2. **Pi's built-in model catalog**, read through `@earendil-works/pi-ai`'s `providers/all` subpath, as the first-run seed. It is pure static data — no credential, no network — regenerated from models.dev on every pi release, so it can never be older than the pi you are running, and it already carries each model's finished `thinkingLevelMap`. `openai-codex` entries are also registered under `openai/` when that key is free, so CLIProxyAPI's `owned_by: openai` matches the Codex-only ids. A non-`cache` snapshot always counts as stale, so the first model discovery still upgrades it to a live models.dev fetch.

Matching a CLIProxyAPI model id to a catalog entry is identity-first: an explicit alias wins, then an exact id, then a canonical `owned_by` such as `openai`, then a provider hint embedded in a noncanonical owner (`feedmob-opencode-go` → `opencode-go`), then a unique normalized suffix. Only if all of that is unresolved does the configured `metadataFallbackProvider` apply, and only when that provider has exactly one normalized match. Legacy flat caches without source-provider identity are ignored in favour of the seed until a refresh replaces them. Aliases are metadata-only: the registered pi model keeps the original CLIProxyAPI id so requests still route through the proxy correctly.

## Attribution

Forked from [`0xRichardH/pi-cliproxyapi-provider`](https://github.com/0xRichardH/pi-cliproxyapi-provider) (MIT, Copyright (c) 2026 Richard Hao). See [LICENSE](LICENSE).
