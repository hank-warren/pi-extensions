# @hank-warren/pi-stats

## 0.4.1

### Patch Changes

- c079c51: Scan sessions through a bounded worker pool instead of one file at a time.

  The stats scan now runs an ordered pool capped at eight concurrent readers, reduced by the discovery index, which shortens a cold scan over a large session history. Results stay in discovery order regardless of completion order, and progress is reported monotonically.

  Cancellation is settled rather than abandoned: an abort stops further work being assigned and publishes nothing afterwards, but waits for reads already in flight, so the caller's `catch` never runs while file reads are still landing in the result array or progress is still being reported into a dashboard that is being torn down.

## 0.4.0

### Minor Changes

- 5e0e3f5: Add Tools and Projects tabs to the `/stats` dashboard.

  The Tools tab ranks every recorded tool call for the selected range by call count, with a share bar, error count, and error rate. Tool calls are now tallied from every tool result, not just the few that record model usage, and the `Source` column names the package that registered each tool so extension-provided tools are distinguishable from built-ins. Tools from extensions that are no longer installed still rank but show no source.

  The Projects tab rolls sessions up by their recorded working directory, ranked by tokens, with session counts and cost.

  Tool calls are counted separately from token usage and never affect model attribution. They de-duplicate on the provider tool-call id, so forked sessions do not inflate counts. `Tab` and the arrow keys now cycle four tabs and wrap in both directions.

  The cache format is bumped to version 3 to store the new tool tallies, so the first run after upgrading performs one full rescan.

## 0.3.3

### Patch Changes

- cf12677: ship CHANGELOG.md in the published tarball
- 596888b: keep extension sidecar usage when the current session is not yet on disk

## 0.3.2

### Patch Changes

- 187e12c: Roll usage-free placeholder models into `Tools/summaries` and let the activity heatmap use the full terminal width.

  Pi records placeholder assistant turns whose model is the literal `<synthetic>` (a missing model normalizes to `unknown`). With no tokens and no cost they produced their own empty model row; they are now attributed to the existing unattributed bucket, while a placeholder that did record spend keeps its own row.

  The heatmap previously shrank to the recorded history, leaving most of a wide terminal blank. It now claims the available width up to a full year, drawing weeks before the first recorded session as empty cells that fill in over time.

## 0.3.1

### Patch Changes

- 67abcf5: expand the readme with try-it install, a configuration table, and troubleshooting
