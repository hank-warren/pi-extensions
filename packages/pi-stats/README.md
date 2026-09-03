# @hank-warren/pi-stats

A compact, theme-aware `/stats` dashboard for [Pi](https://pi.dev). It totals the usage already recorded in local Pi session JSONLs, including persisted `pi-subagents` child sessions.

## Install

```bash
pi install npm:@hank-warren/pi-stats
```

Try it for a single run without installing:

```bash
pi -e npm:@hank-warren/pi-stats
```

Do not install this standalone package on a host that also installs the aggregate `hank-warren/pi-extensions` Git package; that would load the extension twice.

## Use

Run `/stats` in interactive mode. The dashboard temporarily replaces the editor and closes with `Escape`.

- `Tab` or `←`/`→`: cycle Overview, Models, Tools, and Projects (wraps in both directions)
- `↑`/`↓`: scroll the list on Models, Tools, and Projects
- `r`: cycle All time, Last 7 days, and Last 30 days
- `e`: toggle compact totals (`1.5B`) and exact grouped digits (`1,486,201,553`)
- `u`: force a full rescan and rebuild the session index
- `Escape`: close

The Overview compares current-session, selected-range, and all-time usage in one aligned table covering input, output, cache read, cache write, reasoning, cache-hit rate, and recorded cost, followed by a month-labelled activity heatmap and all-time session, streak, and favourite-model highlights. The heatmap always spans the width the terminal offers, up to a full year; weeks before your first recorded session render as empty cells and fill in as history accumulates. Reasoning is shown as a subset of output and is never added to the total twice.

The Models tab ranks models for the selected range with share bars and a totals row that reconciles with the range total. It attributes assistant usage to the provider response model and keeps otherwise unattributed nested usage in `Tools/summaries`.

The Tools tab ranks every recorded tool call for the selected range by call count, with a share bar, an error count, and an error rate. Most tool calls record no model usage at all, so they are counted separately from tokens and never affect model attribution. The `Source` column names the package that registered each tool, read from the live tool registry, so extension-provided tools are distinguishable from built-ins at a glance. Because the registry only knows what is installed right now, a tool from an extension you have since removed still appears in the ranking but shows `—` instead of a source.

The Projects tab rolls sessions up by the working directory recorded in each session header, ranked by tokens, with session counts and recorded cost. Sessions whose header carries no working directory are omitted.

Every tab is responsive: as the terminal narrows, lower-priority columns move to a labelled continuation line under each row instead of disappearing, and the layout stays within a standard 24-row terminal.

## What is counted

Pi writes usage to assistant messages, usage-bearing tool results, compactions, and branch summaries. `pi-stats` recursively reads valid Pi session files and counts every recorded model call, including compacted and abandoned branches. Copied fork history is fingerprinted and counted once.

Tool calls are counted separately from tokens, because most of them record no model usage. Every tool result in a session is tallied by name, along with whether it reported an error. Provider tool-call ids are reused verbatim when a session is forked, so they double as the de-duplication key and a forked branch never inflates the counts. Namespaced names such as `functions.bash` are ranked under their base name.

Persisted subagent files in the conventional `run-*/session.jsonl` layout are included. `pi-processes` does not create model sessions; model usage around its tool calls already belongs to the parent Pi session and therefore needs no separate integration.

### Extension usage sidecars

Some extensions call a model outside the agent loop, so their usage never reaches a session transcript. `pi-stats` also reads content-free usage sidecars at `<agent dir>/<extension>/usage.jsonl` (plus one rotated `usage.jsonl.1`). Each line is one call:

```json
{"v":1,"id":"3f2b…","ts":"2026-08-11T22:41:03.118Z","source":"auto-permissions","label":"guardian","provider":"anthropic","model":"claude-fable-5","usage":{"input":812,"output":96,"cacheRead":18442,"cacheWrite":0,"reasoning":48,"cost":0.0121}}
```

Records are de-duplicated by `id`, counted in every total, and shown as their own `provider/model (label)` row so the overhead stays visible. They never create sessions, so session counts, streaks, and session spans are unaffected. `@hank-warren/pi-auto-permissions` writes one for guardian reviews; set `PI_STATS_DISABLE_USAGE_SIDECARS=1` to ignore all of them.

The standard Pi session root, the current external session directory, `PI_CODING_AGENT_SESSION_DIR`, and a configured `subagents.defaultSessionDir` are discovered automatically. Add unusual one-off roots with the platform-delimited `PI_STATS_SESSION_DIRS` environment variable.

## Configuration

There is no config file; behavior is controlled entirely by environment variables.

| Env var | Default | Purpose |
| --- | --- | --- |
| `PI_STATS_DISABLE_USAGE_SIDECARS` | unset | Set to `1` to ignore all extension usage sidecars and count only session transcripts. |
| `PI_STATS_SESSION_DIRS` | unset | Extra session roots to scan, joined by the platform path delimiter (`:` on Unix, `;` on Windows). Added to the automatically discovered roots. |
| `PI_CODING_AGENT_SESSION_DIR` | unset | Standard Pi variable; the directory it names is picked up as a session root. |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Standard Pi variable; determines where the cache and sidecars are read from. |

Each variable is matched exactly: `PI_STATS_DISABLE_USAGE_SIDECARS=true` does nothing, only `=1` disables sidecars.

## Troubleshooting

**Totals look too low, or a session is missing.** Press `u` in the dashboard to force a full rescan and rebuild the index; the cache keys off file stat identity, so a session restored from backup with older timestamps can otherwise be skipped. If the sessions live outside the standard root, add their directory to `PI_STATS_SESSION_DIRS`.

**Guardian or other extension usage is missing.** Sidecar reading is skipped entirely when `PI_STATS_DISABLE_USAGE_SIDECARS=1`. Otherwise confirm the writing extension is enabled and that `<agent dir>/<extension>/usage.jsonl` exists; sidecars are only discovered one level below the agent directory.

**A tool shows `—` in the Source column.** The source is resolved from the live tool registry, which only knows currently installed tools. A tool recorded by an extension that is no longer installed keeps its ranking but cannot be attributed to a package. This is also expected for sessions created by a different Pi host.

**Tool counts jumped after upgrading.** Versions before this one did not record tool calls at all, and the cache was rebuilt once on first run to backfill them from your existing sessions. The one-time rescan is expected; later runs reuse the cache as usual.

**A model shows under `Tools/summaries` instead of its own row.** That bucket holds nested usage that carries no attributable response model, such as some compaction and branch-summary records. It also absorbs Pi's own placeholder turns — assistant messages whose model is `<synthetic>` or missing — but only when they recorded no tokens and no cost; a placeholder that was actually billed keeps its own row so the spend stays visible. Everything in the bucket is counted in the totals either way.

**Costs read `$0.00` or look wrong.** Displayed cost is whatever Pi already recorded in the session; `pi-stats` performs no pricing lookup and contacts no billing API. Providers used through a subscription or proxy commonly record zero cost.

**The dashboard looks cramped.** Columns collapse onto a labelled continuation line as the terminal narrows. Widen the terminal to restore the single-line layout, or press `e` to switch to compact totals.

**Reset everything.** Delete `~/.pi/agent/pi-stats/cache.json` (path follows `PI_CODING_AGENT_DIR`). It is a disposable index and the next `/stats` run rebuilds it from the sessions.

## Cache and privacy

Sessions remain authoritative. For fast repeat opens, the extension stores one disposable index:

```text
~/.pi/agent/pi-stats/cache.json
```

The location follows `PI_CODING_AGENT_DIR`. The cache contains file stat identity, session IDs/timestamps/working directories, model names, tool names with call and error counts, usage counters, and de-duplication fingerprints. It never stores prompts, responses, tool arguments, tool output, or other conversation content. It is written atomically with mode `0600` and can be deleted at any time; the next `/stats` invocation rebuilds it.

No network or billing API is used. Displayed costs are the estimates already recorded by Pi.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.
