# @hank-warren/pi-image-prune

## 0.1.0

### Minor Changes

- Initial release: prune the oldest images from outgoing requests so image-heavy sessions stay under a provider's request size limit instead of failing with a 413 and compacting. Claude Code's limits apply on the Anthropic Messages API by default; configured per-model rules count the whole request, for proxied routes such as CLIProxyAPI's Devin backend (10 MiB). Pruned images leave a note saying whether the model had already seen them. Fork of `@ogulcancelik/pi-anthropic-image-cap`.
