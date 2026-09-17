# Expose the complete Pi model registry

> **Superseded by [ADR 0022](0022-scope-the-catalog-and-fall-back-to-a-default-model.md)**
> in this fork: the catalog is scoped by a glob and an unoffered slug resolves to a
> default rather than failing. The reasoning below still holds for a deployment that
> sets `PI_CODEX_APP_SERVER_MODELS=**`.

`model/list` exposes every model available through Pi's Model Registry, including non-OpenAI providers. Exact provider and model selections pass through to Pi without request rewriting or implicit fallback; unavailable selections fail explicitly, while client-specific display limitations are handled as compatibility concerns rather than narrowing the server's model catalog.
