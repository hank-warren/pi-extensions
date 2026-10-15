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
- Images inside tool results become `[media removed: request limit]`; images you attached to a message are removed.
- Other models are untouched.

Images go in batches, not one per turn. Each batch changes the start of the request once, costing one prompt-cache miss; the requests between batches share an unchanged prefix and keep hitting the cache. The gap between `maxRequestBytes` and `trimToBytes` sets how often that happens. Decisions depend only on the conversation up to each image (plus, for a rule, the system prompt and tool definitions), so an image once left out stays out while those are unchanged.

When a new batch is left out, Pi shows a one-line notice with the estimated request size and the limit.

## Configuration

`~/.pi/agent/pi-image-prune.json` (under `PI_CODING_AGENT_DIR` when set):

```json
{
  "rules": [
    { "models": ["cpa/devin/*", "cpa/claude-opus-5-5"], "maxRequestBytes": 9500000, "trimToBytes": 6500000 }
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

Devin accepts at most 10,485,760 bytes per request, enforced before any model runs, and CLIProxyAPI's translation adds about 0.35% to a real Pi request. Cover every model id that can reach Devin: the `devin/` ids, and any bare id CLIProxyAPI forks onto Devin as a fallback through `oauth.model-alias` (`claude-opus-5-5` in the example above). A fallback id gets the smaller limit even when the request ends up at Anthropic, because Pi cannot see which backend will answer.

## Install

Remove the upstream package before installing this fork:

```bash
pi remove npm:@ogulcancelik/pi-anthropic-image-cap
pi install npm:@hank-warren/pi-image-prune
```

Restart Pi after changing packages. A git install of this repository already includes the fork; do not also install its npm package.
