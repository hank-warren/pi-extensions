# @hank-warren/pi-cliproxyapi-provider

## 0.3.0

### Minor Changes

- Publish pi's native Claude mid-conversation system messages and tool changes, so a system-prompt or tool change mid-session no longer rewrites the prompt cache.

  - Claude models that pi's native catalog marks with `supportsMidConvoSystemMessages` and `supportsMidConvoToolChanges` now carry them. A later system-prompt change is sent as a `role: "system"` message, and a tool change as `tool_addition`/`tool_removal` blocks against deferred declarations. Measured through CLIProxyAPI v8.0.15: across a mid-session tool change, the next turn read the whole 17.8k-token prefix from cache, where the previous behaviour read none of it and rewrote it.
  - **This requires CLIProxyAPI v8.0.4 or later.** Earlier releases do not rewrite tool names inside `tool_addition`/`tool_removal` blocks for OAuth credentials (router-for-me/CLIProxyAPI#6174), so the first request after a tool change fails with "references unknown tool". Set `"midConversationUpdates": false` under `pi-cliproxyapi-provider` in `settings.json`, or disable it in `/cliproxyapi config` → `Models`, for older proxies. It is independent of `perTurnEffort` (v8.0.3+).
  - `/cliproxyapi status` reports the new setting.

## 0.2.2

### Patch Changes

- Typecheck against pi 0.99 and 1.0: the model list is kept as the package's own chat-model type throughout and widens to pi's chat | image | classifier union only at `registerProvider`, so `model-ui.ts` compiles again. Types only; runtime behavior is unchanged, and pi 0.84 still typechecks.

## 0.2.1

### Patch Changes

- Typecheck against pi 0.99, whose `ProviderModelConfig` is a chat | image | classifier union: `compat` and `api` are now taken from the chat member. Types only; runtime behavior is unchanged, and pi 0.84-0.87 still typecheck.

## 0.2.0

### Minor Changes

- Take Claude and Codex wire profiles from pi's native catalogs, and switch Claude effort per turn.

  - Claude and Codex-served GPT models now use the running pi's `anthropic` and `openai-codex` catalogs for their thinking maps, reasoning flag and context window. The hand-written GPT-5.5, GPT-5.6 and GPT-6 rules remain only as fallbacks for ids pi does not list. As a result:
    - GPT-5.6 `minimal` sends `low` instead of being rejected by the Codex route.
    - GPT-5.5 and every other model in pi's Codex catalog go over the Responses API.
    - GPT-5.3 Codex Spark advertises its real 128000-token window.
  - Opus 5, Opus 5.5 and Fable 5.1 publish `supportsMidConvoEffort`. Changing the thinking level mid-session becomes a per-turn directive, so the prompt cache survives the switch.
  - **This requires CLIProxyAPI v8.0.3 or later.** Older releases reject the directive and fail every request to those models. Set `"perTurnEffort": false` under `pi-cliproxyapi-provider` in `settings.json`, or disable it in `/cliproxyapi config` → `Models`, to keep top-level effort.

## 0.1.1

### Patch Changes

- Ship the startup fix the 0.1.0 changelog announced. 0.1.0 was published from the package's initial merge (#20), before the perf work in #21 landed; #21 then re-applied a changeset onto the same version, so its publish was skipped as already on npm. The registry's 0.1.0 tarball is the pre-fix code (~3.3 s of startup on a warm cache). This release carries the indexed metadata catalog, offline `refreshModels` reuse of the current snapshot, and the pruned models.dev cache; measured startup for the extension drops from ~3.9 s to ~0.7 s.

## 0.1.0

### Minor Changes

- Initial publication of the fork of `0xRichardH/pi-cliproxyapi-provider` (0.15.23 at `hank-warren/pi-cliproxyapi-provider@3a4d021`), with two changes:

  - The 4.7 MB `models-dev-fallback.json` first-run seed is replaced by pi-ai's own built-in model catalog, read at runtime from `@earendil-works/pi-ai/providers/all`. It ships zero bytes, is regenerated on every pi release, and carries a finished `thinkingLevelMap` per model. `/cliproxyapi status` reports it as `builtin (pi catalog generated <age>)`; the live models.dev fetch still replaces it on the first model discovery.
  - Startup cost drops from ~3.3 s to ~0.2 s on a warm cache: the metadata catalog is indexed once per snapshot instead of scanned per model, offline `refreshModels` calls reuse the current snapshot instead of re-reading the cache, and the cache is pruned to the nine models.dev fields the provider reads (7.5 MB → under 3 MB).
