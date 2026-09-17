# 22. Scope the model catalog, and fall back instead of failing

Date: 2026-09-17

## Status

Accepted. Supersedes [ADR 0014](0014-expose-the-complete-pi-model-registry.md).

## Context

ADR 0014 decided that `model/list` exposes every model in Pi's registry, that
selections pass through unrewritten, and that an unavailable selection fails
explicitly, treating a client's display limits as the client's problem. Two
things in practice argue against each half of that.

**The catalog.** A Codex client renders one flat picker with no provider
grouping. On this host Pi's registry is 130 models across seven providers, and
55 of them come from CLIProxyAPI, which also publishes account-pinned aliases —
`plus/gpt-5.5`, `team/gpt-5.6-luna`. Those are not merely noise in a long list:
picking one pins the request to a specific upstream subscription, which takes
the account decision away from CLIProxyAPI's own round-robin, session affinity
and quota failover. A picker that offers them invites a client to defeat the
proxy's scheduling by accident.

**The fallback.** "Unavailable selections fail explicitly" assumes every
selection comes from our own `model/list`. The ChatGPT app's background helper
does not work that way: it starts threads with bare Codex slugs such as
`gpt-5.4-mini`, which name no Pi provider at all. Failing those produced
`Unknown Pi model: gpt-5.4-mini` and a thread that would not start, for a
request the user never made and cannot see.

## Decision

`PI_CODEX_APP_SERVER_MODELS` holds comma-separated globs over `provider/model`
(default `cpa/*`), and only matching models are offered.
`PI_CODEX_APP_SERVER_DEFAULT_MODEL` names the default (default
`cpa/claude-opus-5`). A slug this server does not offer — unknown, bare, or
deliberately excluded — resolves to that default rather than failing the
request.

Globs are ordinary: `*` matches within one slash-separated segment, `**`
crosses them. That distinction is doing real work, because model keys are
`provider/id` and CLIProxyAPI's pinned aliases carry a slash inside the id. So
`cpa/*` means CLIProxyAPI's own models and excludes `cpa/plus/gpt-5.5`, while
`cpa/plus/*` asks for the pinned ones deliberately and `cpa/**` takes
everything.

A glob that matches nothing falls back to the whole catalog. An empty picker
leaves a client unable to start any turn at all, which is a worse failure than a
visibly wrong catalog.

## Consequences

- The picker on a paired phone lists 43 CLIProxyAPI models with
  `cpa/claude-opus-5` preselected, and no pinned alias, so CLIProxyAPI keeps
  deciding which account serves a request.
- The adapter now rewrites a model selection, which ADR 0014 forbade. The
  rewrite is visible: the resolved model is what `thread/start` reports back,
  and the daemon logs the request it received.
- A deployment that wants upstream's behaviour sets
  `PI_CODEX_APP_SERVER_MODELS=**`, which restores ADR 0014's catalog. The
  fallback has no opt-out, because the client that needs it cannot be
  configured.
- Filtering happens on the way out of Pi's registry, not inside it: Pi's own
  model selection in a TUI session is untouched, including for sessions this
  daemon created.
