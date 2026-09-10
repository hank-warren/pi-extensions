# @hank-warren/pi-cliproxyapi-provider

## 0.1.1

### Patch Changes

- Ship the startup fix the 0.1.0 changelog announced. 0.1.0 was published from the package's initial merge (#20), before the perf work in #21 landed; #21 then re-applied a changeset onto the same version, so its publish was skipped as already on npm. The registry's 0.1.0 tarball is the pre-fix code (~3.3 s of startup on a warm cache). This release carries the indexed metadata catalog, offline `refreshModels` reuse of the current snapshot, and the pruned models.dev cache; measured startup for the extension drops from ~3.9 s to ~0.7 s.

## 0.1.0

### Minor Changes

- Initial publication of the fork of `0xRichardH/pi-cliproxyapi-provider` (0.15.23 at `hank-warren/pi-cliproxyapi-provider@3a4d021`), with two changes:

  - The 4.7 MB `models-dev-fallback.json` first-run seed is replaced by pi-ai's own built-in model catalog, read at runtime from `@earendil-works/pi-ai/providers/all`. It ships zero bytes, is regenerated on every pi release, and carries a finished `thinkingLevelMap` per model. `/cliproxyapi status` reports it as `builtin (pi catalog generated <age>)`; the live models.dev fetch still replaces it on the first model discovery.
  - Startup cost drops from ~3.3 s to ~0.2 s on a warm cache: the metadata catalog is indexed once per snapshot instead of scanned per model, offline `refreshModels` calls reuse the current snapshot instead of re-reading the cache, and the cache is pruned to the nine models.dev fields the provider reads (7.5 MB → under 3 MB).
