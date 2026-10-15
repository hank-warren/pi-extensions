# pi-image-prune

> **Fork.** Based on [`@ogulcancelik/pi-anthropic-image-cap` 0.1.0](https://github.com/ogulcancelik/pi-extensions/tree/e34f816ec8234f9b012bf6e19f9b94c19d123d03/packages/pi-anthropic-image-cap) by Can Celik (MIT). Adds per-model limits that count the whole request, for routes whose limit is not Anthropic's. Do not load this fork and the upstream package together: both would prune the same requests.

Keeps image-heavy sessions under a provider's request size limit by leaving the oldest images out of outgoing requests.

## The problem

Pi sends the whole conversation on every turn, images included, and tracks context in tokens, not bytes. Images are cheap in tokens and heavy in bytes, so a session with a few dozen screenshots can pass a provider's byte limit while its context is mostly empty. Pi reads the resulting `413 request_too_large` as a full context and compacts the session.

The limit depends on who answers the request, not on its API. Anthropic rejects requests over 32 MB. A proxy can route the same Anthropic Messages request somewhere else: CLIProxyAPI's Devin backend accepts at most 10 MiB, measured live, for every Devin model regardless of family.

## What this does

Before each request, it drops the oldest images from what gets sent. Your saved session keeps every image; nothing is summarized.

- **Default (Anthropic Messages API, no rule):** Claude Code's limits, as described in its docs under [Accumulating many images](https://code.claude.com/docs/en/prompt-caching#accumulating-many-images) and matching Claude Code 2.1.282. Past 24 MiB of images, the oldest are dropped until under 14 MiB. Past 100 images (600 on 1M-context models), the oldest are dropped until 80 (580) remain.
- **Configured rule (any API):** the whole request counts — text, tool results, system prompt, tool definitions and images — against `maxRequestBytes`. Crossing it drops the oldest images until the estimate is at or below `trimToBytes`. Text is never dropped.
- Each image left out is replaced with a short note. If the model already saw the image (it was in the request that produced an earlier reply), the note says so, and that what it said then was based on the real image. If it never did (several images arrived at once and the oldest went out in their first request), the note says that instead. Upstream and Claude Code use `[media removed: request limit]` for tool results and drop user images silently; in testing, Opus read that as the image never having been delivered and retracted its earlier, correct descriptions as made up.
- Other models are untouched.

Images go in batches, not one per turn. Each batch changes the start of the request once, costing one prompt-cache miss; the requests between batches share an unchanged prefix and keep hitting the cache. The gap between `maxRequestBytes` and `trimToBytes` sets how often that happens. Decisions depend only on the conversation up to each image (plus, for a rule, the system prompt and tool definitions), so an image once left out stays out while those are unchanged.

When a new batch is left out, Pi shows a one-line notice with the estimated request size and the limit.

The finished provider payload gets a second pass, because it can differ from what the context hook saw: `@hank-warren/pi-codex-compaction` rebuilds the request after a native checkpoint, adding the checkpoint's retained history and encrypted state. That pass applies the same limits and oldest-first batches to the payload exactly as it will be sent, and reads whether each image was seen from the replies that follow it in the payload. Load this package after pi-codex-compaction (the repository's manifest already does) so its payload hook runs last.

## Configuration

`~/.pi/agent/pi-image-prune.json` (under `PI_CODING_AGENT_DIR` when set):

```json
{
  "rules": [
    { "models": ["cpa/devin/*"], "maxRequestBytes": 9500000, "trimToBytes": 6500000 }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `models` | `provider/id` globs; `*` matches anything, `/` included. The first matching rule wins. |
| `maxRequestBytes` | Estimated whole-request size that triggers pruning. Leave margin below the real limit: the estimate is Pi's view of the request, and a proxy may grow it in translation. |
| `trimToBytes` | Size a prune brings the request back down to. Optional, defaults to 70% of `maxRequestBytes`. |
| `maxImages` | Optional image count limit. Defaults to Claude Code's on the Anthropic Messages API, none elsewhere. |

Unknown fields are errors. A malformed file is ignored with a warning, leaving the defaults in place. The file is read at session start; `/reload` picks up edits.

### CLIProxyAPI and Devin

Devin accepts at most 10,485,760 bytes per request, enforced before any model runs, and CLIProxyAPI's translation adds about 0.35% to a real Pi request. Cover every model id that can reach Devin: the `devin/` ids, plus any bare id CLIProxyAPI forks onto Devin as a fallback through `oauth.model-alias`. A fallback id needs the smaller limit even when the request ends up at Anthropic, because Pi cannot see which backend will answer; dropping the alias and choosing `devin/…` explicitly keeps the bare id on Anthropic's limit.

## Install

Remove the upstream package before installing this fork:

```bash
pi remove npm:@ogulcancelik/pi-anthropic-image-cap
pi install npm:@hank-warren/pi-image-prune
```

Restart Pi after changing packages. A git install of this repository already includes the fork; do not also install its npm package.
