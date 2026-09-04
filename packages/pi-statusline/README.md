# pi-statusline

Replaces Pi's default footer with a compact statusline:

```text
gpt-5.6-sol | pi-extensions:main* ⇣1 | 40k/1.0m |  97·54  80
⑂ pi-extensions:feature/statusline* ⇣2 #7 | infra:fix/alerts #168
019fafa7-29c0-7e99-9f82-5794d5721848
```

## What it shows

- **Line 1** — active model ID, optionally the provider of that model, current directory basename and Git branch, current context usage/window, subscription usage headroom (see below), and any [custom items](#custom-items) you configure. A yellow `*` marks a dirty checkout and `⇣N` shows how many commits it is behind its locally known upstream ref. Unknown context usage is rendered as `?/<window>` until Pi can provide an estimate. Exceptional prompt-cache hits trigger the celebration described below.
- **Worktree lines** — when the session works in or sends tool calls into linked worktrees, one line shows the same branch/dirty/behind state for each worktree plus its associated PR number.
- **Final line** — the full Pi session ID.

Colors come from a selectable [theme](#themes), with context warning thresholds. Every element can be turned off from [`/statusline`](#statusline).

## `/statusline`

`/statusline` opens a `/settings`-style menu (TUI mode only) for configuring the footer. Changes apply live and persist immediately:

- **Theme** — the color palette, cycled with Enter or Space. See [Themes](#themes).
- **Cache celebration** — `off` or one of five badge animations, cycled with Enter or Space and previewed live in the statusline below. See [Animation styles](#animation-styles).
- **Custom items** — `on`/`off` for the whole custom-item segment, and **Custom item list** below the alias row enables or disables each configured item and shows what it is currently doing. See [Custom items](#custom-items).
- **Model**, **Provider**, **Directory & git**, **Context**, **Subscription usage**, **Worktree line**, **Session ID line** — `on`/`off`, cycled with Enter or Space. **Provider** is the only one that starts `off`; it shows the provider id exactly as Pi reports it, so a [pi-multi-login](../pi-multi-login) alias renders as `anthropic-team` and names the login actually spending — something a model id like `claude-opus-5` never carries. With no model, or a model reporting no provider, the segment is simply absent. Disabled segments are dropped from line 1 without leaving a stray ` | ` separator; hiding the worktree line also stops its `git`/`gh` polling, and hiding usage stops the usage poller. With every element off the footer collapses to a single blank row.
- **Worktree root** — the directory whose immediate children are tracked as session worktrees (default `~/repos/worktrees`). `~` and `$HOME` are expanded; a relative path is rejected and the previous value kept.
- **Repo aliases** — short display names for repositories on the worktree line. Enter edits the selected `repo → alias` pair, `d` deletes it, and `Add alias…` creates one from a `repo=alias` line.

Settings live in a single global file, `~/.pi/agent/statusline-settings.json`, written atomically. Only values differing from the defaults are stored, unknown keys from a newer version are preserved, and a missing or malformed file simply yields defaults.

Saves are per-key rather than whole-file: a change writes only the fields it actually touched over whatever is on disk at that moment. Sessions load settings once at startup, so a whole-file write would let a session that started hours ago revert edits it never saw — including hand edits and changes made in another session. Opening `/statusline` also re-reads the file first, so the menu always edits current state. Two sessions changing the *same* field are still last-writer-wins; everything else merges.

### Adding a setting

A setting is persisted, validated, diffed, and rendered in separate places, so add it to all of them:

1. `StatuslineSettings` in `settings.ts` — plus `BOOLEAN_SETTING_KEYS` if it is a toggle.
2. `defaultSettings()`.
3. `normalizeSettings()` — the `known` key set, and a parse branch that falls back to the default for an invalid value rather than discarding the whole file.
4. `serializeSettings()` — write it only when it differs from its default, keeping the file sparse.
5. `SETTING_KEYS`.
6. A row in `buildSettingItems()` and a branch in `applySettingChange()` in `settings-menu.ts`, placed in the order the element renders.
7. Live-apply handling in `applySettings()` in `index.ts`, if the change needs more than a repaint (disposing a poller, forcing a full redraw on a row-count change).

Steps 1 and 5 are enforced: omitting the key from `SETTING_KEYS` fails `npm run typecheck` by name, and a test asserts it matches the keys of `defaultSettings()`. Nothing enforces steps 3, 4, 6 or 7 — a setting missing from `serializeSettings` applies live and never persists.

Compatibility rules, because old and new versions share one file:

- **Never change a key's type or meaning — add a sibling key.** This is why `showCacheCelebration` stayed a boolean when it gained animation styles: an older version reading a repurposed key falls back to its default and can write that fallback back.
- **Unknown keys survive an older version; unknown *values* do not.** A theme name a reader does not recognise falls back to `default`, and a whole-file write from that reader drops the choice. Extending a cosmetic enum is fine; encoding behaviour in one is riskier than adding a key.
- **Keep settings independent.** Per-key saves mean two fields can be written by different sessions at different times, so resolve any relationship between settings at render time, not on disk.

## Themes

| Name | Notes |
|---|---|
| `default` | The palette this package has always used — blue model, cyan branch, neon magenta/cyan cache badge |
| `dracula` | [Dracula](https://draculatheme.com), with the pink `#ff79c6` branch color used in Herdr sidebar configs |
| `github-dark` | GitHub's dark default |
| `catppuccin-mocha` | [Catppuccin](https://catppuccin.com) Mocha |
| `white` | No color: white text, dimmed punctuation, a white/grey badge flash |

A theme maps eleven roles — `model`, `path`, `branch`, `text`, `dim`, `ok`, `warn`, `caution`, `danger`, `accent`, and the two `celebration` badge frames — so switching recolors every element at once without changing a single character of rendered text. `ok`/`warn`/`caution`/`danger` drive the context meter, the usage meters, and the dirty/behind markers alike, so the warning gradient stays legible in every theme. An unknown theme name in the settings file falls back to `default`.

### Repo aliases are no longer built in

Up to 0.2.x this package hardcoded five alias pairs and stripped a `platform-` prefix from every other repository. Those rules were specific to one machine and shipped to everyone. From 0.3.0 the alias map starts empty and repository names render verbatim — add whatever pairs you want under `/statusline → Repo aliases`.

## Subscription usage meters

When Pi's `~/.pi/agent/auth.json` contains OAuth credentials for Anthropic (Claude subscription) and/or OpenAI Codex, line 1 shows **percent remaining** for each rate-limit window after the context meter:

- ` 97·54` — Claude 5-hour, then weekly remaining percent (Nerd Font `nf-cod-claude` icon). Subscriptions with a model-scoped weekly limit (e.g. Fable) show it as a third number — ` 97·54·24` — and it is omitted when the account has none.
- ` 92·99` — Codex 5-hour, then weekly remaining percent (`nf-cod-openai` icon). Which windows exist is a property of the plan, so the slots are filled from the payload's window spans rather than from its plan name: a plan with no 5-hour limit shows the weekly number alone — ` 45` — and a free plan, whose single window is monthly, shows that one number in the same place.

Numbers are colored by remaining headroom: green above 60, yellow 41–60, orange 16–40, red at 15 and below.

Usage is fetched from the providers' own usage endpoints with Pi's stored tokens — read-only; tokens are never refreshed or written. Fetches are driven by session start, each turn, and a ten-second tick while the footer is mounted, throttled per provider — five minutes for Claude, sixty seconds for Codex (the Anthropic usage endpoint rate-limits aggressively), and are strictly best-effort: on any failure the last-known value is kept, and providers without credentials (or before the first successful fetch) are simply omitted, leaving the statusline exactly as before. While a provider that *does* have credentials still has no value, the throttle drops to 30 seconds — Pi only refreshes an expired OAuth access token when that provider is first used, so a session starting with a stale Anthropic token would otherwise show no Claude meter for a full interval.

### Which account each meter shows

With a single login per provider — the ordinary case, including logging out and back in as a different Anthropic account — nothing here applies: each meter shows that provider's account, exactly as before.

When [`@hank-warren/pi-multi-login`](../pi-multi-login/README.md) has registered additional logins (`anthropic-work`, `openai-codex-alt`), a provider family can hold several accounts at once. Each meter then shows **the account behind the main model**, falling back to the base account (`anthropic`, `openai-codex`) when the main model belongs to the other family. So switching the main model between two Claude logins swaps the Claude meter and leaves the Codex meter alone, and a login used only for background work — such as a `pi-auto-permissions` reviewer, which is never the main model — is never polled at all. There is deliberately no marker for *which* account is shown: the meter tracks whatever you are actually spending.

### Polling and the shared cache

Polling is host-wide, not per-session. Usage percentages describe the account rather than the session, and a busy machine runs dozens of pi processes, so every process shares `~/.pi/agent/statusline-usage.json`, written atomically via a temp file and rename. It is keyed by **credential id**, one entry per account, each holding that account's last good values plus the time its last poll was *started*. A session adopts the cached values for its selected accounts on first refresh — so the meters are populated before it has issued a single request, and switching back to an account polled earlier repaints with no request at all — and only polls an account whose timestamp is older than the interval. Keying by account rather than by provider family is what lets two sessions on two different Anthropic logins coexist: keyed by family, each looked like an account switch to the other, so they evicted each other's values and re-polled every cycle.

The two intervals differ because the endpoints do. OpenAI's own Codex CLI polls `wham/usage` every sixty seconds, and independent community tools converge on the same figure, so matching the first-party client is well inside what that endpoint expects. Anthropic's usage endpoint is the opposite — it rate-limits hard enough that a whole ecosystem of statusline tools has been stuck in permanent 429 loops — so Claude keeps the conservative five minutes. The two had shared one interval only because it was written for the stricter of them, leaving the Codex meter five times more conservative than the vendor's own client for no reason.

The ten-second tick does not increase request volume; it only stops the meters from being pinned to turn boundaries. A throttled refresh issues no request at all — it reads `auth.json` and the shared cache, publishes whatever another process has already fetched, finds the poll gate closed and returns — so the tick costs two small local reads and buys the two things the previous turn-driven cadence could not: an **idle** session's meters keep moving (quota recovers on a wall clock, not on your turns), and a sibling process's fresh values are adopted within one tick instead of waiting for this session's next turn to end. It also means the poll itself happens when the five-minute window opens rather than at the first turn that ends after it. The tick is `unref`ed, runs only in TUI mode, and stops with the footer — so turning the usage segment off still stops all polling.

A provider answering **429** is left alone before being polled again. When the response carries a usable `Retry-After` — either form, delta-seconds or an HTTP-date — that instruction is authoritative and is used exactly. Otherwise a flat fifteen-minute window applies, because a 429 that says nothing about when to return is only telling us the endpoint wants a break. A `Retry-After` that is not in the future is discarded rather than clamped: Anthropic's usage endpoint is widely reported to answer `retry-after: 0` while still refusing requests, so obeying it literally would retry straight back into the limit that produced it. Any successful poll clears the block.

Cached values also expire at a **window boundary**, not just by age. Each entry records the soonest moment any of its windows rolls over — from Anthropic's `resets_at`, or Codex's `reset_at` (absolute, preferred) or `reset_after_seconds` (relative, resolved against our clock). Once that moment passes, the stored percentages describe the window that just *ended*: they are not merely old, they are wrong, and no age-based expiry can see it. Such a value is never adopted from the cache and never kept as a last-known-good, and the account becomes pollable immediately rather than waiting out its interval, so the post-reset numbers appear promptly. An active 429 backoff still outranks a boundary — a rate-limited endpoint is the last thing to argue with the moment its window turns over. A value carrying no boundary at all, which is what an entry written by an older statusline looks like, never expires this way.

Cache entries stay compatible in both directions: a Codex entry written by a statusline older than 0.6.0 carries no 5-hour value, so a newer one renders it as a single weekly number until its own next poll fills the second slot, and an older reader ignores the extra value entirely.

An account answering `429` is parked for fifteen minutes (tracked per account, so a rate-limited Anthropic never stops codex from updating) and stops counting as pending, since retrying harder is what earns the rate limit in the first place. Every cache entry is keyed to a fingerprint (a sha256 prefix, never the token itself) of the credential that fetched it: switching accounts — or rotating a token — discards that entry's numbers and backoff and polls immediately, so an exhausted old account's meters never masquerade as the new account's. A logged-out account fails the same check, so the file garbage-collects itself.

Requires a Nerd Font new enough to include the codicon brand glyphs (v3.5.0+); older fonts render them as replacement boxes.

## Custom items

Everything above is built in. **Custom items** are the escape hatch: each one runs a shell command, and its output becomes a segment on line 1, after the usage meters and before the worktree line. This is how a personal metric — a self-hosted quota pool, a deploy status, an on-call flag — gets onto the statusline without being packaged for everybody else.

The contract is deliberately [Claude Code's status line](https://docs.claude.com/en/docs/claude-code/statusline) contract: a command, JSON about the session on **stdin**, one line on **stdout**, ANSI colors passed through. A script written for Claude Code runs here mostly unchanged (see [differences](#differences-from-claude-codes-status-line)).

There is no default item, and with an empty list the feature costs nothing: no process is spawned and no timer runs.

### Configuring one

Items live under `customItems` in `~/.pi/agent/statusline-settings.json`. The file is not created for you until a setting is changed, so write it if it is absent:

```json
{
  "customItems": [
    {
      "id": "cpa",
      "command": "~/bin/cpa-quota --statusline",
      "refreshInterval": 60,
      "timeout": 5
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `command` | yes | Shell command line. Run through `sh -c` (`cmd /d /s /c` on Windows), so pipes, `$VARS`, and `~` work. |
| `id` | no | Stable name, used by the `/statusline` submenu and in error messages. Defaults to `item-1`, `item-2`, …; duplicates get a `#2` suffix. |
| `refreshInterval` | no | Seconds between forced re-runs, on top of the event-driven ones. Omit for event-driven only. |
| `timeout` | no | Seconds before the command is killed. Default `5`, capped at `30`. |
| `enabled` | no | `false` hides the item and stops it running. This is the one field `/statusline` writes. |
| `type` | no | `"command"`, the only supported kind. Any other value is preserved but not run. |

Items render in configuration order, each as its own ` | `-separated segment.

### When a command runs

- at session start,
- at the end of every turn,
- every `refreshInterval` seconds, if set.

A run is skipped while that item's previous run is still going, so a slow command degrades to a lower refresh rate instead of piling up processes. Two runs of the same item are never closer than one second, whatever triggers them. The timer only exists if some enabled item asked for one, ticks at the shortest interval among them, and is `unref`ed and stopped with the footer — turning **Custom items** off in `/statusline` stops all of it.

Use `refreshInterval` for anything whose value moves on a wall clock rather than on your turns: a quota pool refills while you are reading a diff, and an idle session would otherwise show the number from your last turn.

### What the command receives

One JSON object on stdin, and `COLUMNS` in the environment (the footer's current width, exactly as Claude Code provides it):

```json
{
  "version": 1,
  "session_id": "019fafa7-29c0-7e99-9f82-5794d5721848",
  "cwd": "/home/hank/repos/pi-extensions",
  "model": { "id": "gpt-5.6-sol", "provider": "openai-codex" },
  "git": { "branch": "main", "dirty": false, "behind": 0 },
  "context_window": { "used_tokens": 40000, "context_window_size": 1000000, "used_percentage": 4 },
  "usage_remaining": {
    "claude": { "five_hour": 97, "seven_day": 54, "scoped_weekly": 24 },
    "codex": { "five_hour": 92, "weekly": 99 }
  }
}
```

`git` is `null` outside a repository, `usage_remaining.claude` / `.codex` are `null` without credentials for that provider, and `context_window.used_tokens` is `null` before Pi can estimate it. Handle absence rather than assuming a field.

### What the command should print

The **first line of stdout** becomes the segment. Anything after it is ignored — this is a segment on a shared line, not a row the item owns.

- **Colors work.** SGR escapes (`\033[32m`) pass through. Every other escape sequence is stripped, because a cursor move or an erase-line would corrupt the frame the footer is drawn into. Control characters go too, and tabs become spaces.
- **Print nothing to hide.** Empty output is a valid answer, not a failure: it is how an item shows itself only when it has something to say.
- **Output is capped** at 120 characters before the statusline's own truncation.
- **Exit non-zero to signal failure.** The first line of stderr is kept and shown in `/statusline`.

### When a command fails

Failures never reach the agent — the statusline is best-effort and stays silent. A failing item keeps its last good value for up to three consecutive failures, then drops it. That grace is deliberate in both directions: one blip (a laptop between networks) should not blank a working display, and a value that has quietly gone stale is worse than an empty slot, because the number stays plausible while describing a world that has moved on.

To see what an item is doing, open `/statusline` → **Custom item list**. Each row shows its current value, or why there isn't one: `disabled`, `missing command`, `exit 3: …`, `timed out after 5s`, `empty output`, or `no value yet`. Enter toggles an item on or off; commands themselves are edited in the file.

### Keep it fast

The command runs on the footer's schedule, so treat it like a prompt segment. Do slow work elsewhere — a systemd timer, a cron job, a background daemon — and let the item read the result:

```json
{ "id": "quota", "command": "cat /run/user/1000/quota.txt 2>/dev/null", "refreshInterval": 30 }
```

If the item must do the work itself, cache it keyed by `session_id` from the payload (a PID changes every run and defeats the cache).

### Examples

A clock, the smallest possible item:

```json
{ "id": "clock", "command": "date +%H:%M", "refreshInterval": 30 }
```

Kubernetes context, colored, hidden when unset:

```json
{ "id": "k8s", "command": "kubectl config current-context 2>/dev/null | sed 's/.*/\\x1b[35m&\\x1b[0m/'", "refreshInterval": 300 }
```

Pooled subscription headroom across several accounts behind a self-hosted gateway — the case this feature was built for, where the built-in meters cannot help because they read *this* session's credential, not a round-robin pool:

```bash
#!/usr/bin/env bash
# ~/bin/cpa-quota --statusline
curl -sf -m 3 -H "Authorization: Bearer $CPAMP_ADMIN_KEY" \
  "$CPAMP_URL/v0/management/auth-files" |
  jq -r '[.files[] | select(.disabled != true) | .quota.signals]
         | map(select(."X-Codex-Primary-Used-Percent"))
         | if length == 0 then empty else
             "\u001b[36mcpa\u001b[0m " +
             (map(100 - (."X-Codex-Primary-Used-Percent"|tonumber)) | add / length | floor | tostring) + "/" +
             (map(100 - (."X-Codex-Secondary-Used-Percent"|tonumber)) | add / length | floor | tostring)
           end'
```

Using the session payload — warn only when this session's model is on a nearly exhausted account:

```json
{ "id": "low", "command": "jq -r '.usage_remaining.codex.five_hour // 100 | if . < 15 then \"\\u001b[31mLOW \\(.)%\\u001b[0m\" else empty end'" }
```

### Testing an item

The command is an ordinary program, so run it the way the statusline does:

```bash
echo '{"model":{"id":"gpt-5.6-sol"},"usage_remaining":{"codex":{"five_hour":22,"weekly":55}}}' \
  | COLUMNS=120 sh -c '~/bin/cpa-quota --statusline'
```

If that prints one short line, the item will render.

### Differences from Claude Code's status line

| | Claude Code | pi-statusline |
|---|---|---|
| Scope | one command owns the whole status line | many items, each a segment after the built-in ones |
| Config | `statusLine` object in `settings.json` | `customItems` array in `statusline-settings.json` |
| Multi-line output | each line becomes a row | only the first line is used |
| Rate-limit fields | `rate_limits.*.used_percentage` | `usage_remaining.*` — **remaining**, the inverse |
| Refresh | every assistant message, 300 ms debounce | session start, turn end, optional `refreshInterval` |
| Width | `COLUMNS` and `LINES` | `COLUMNS` |

The naming of `usage_remaining` is the one difference worth checking when porting: reading a *remaining* percentage as a *used* one silently inverts the meaning, and a green bar that means "nearly out" is worse than no bar.

### A note on trust

An item is a command that runs automatically in every TUI session, so `customItems` is executable configuration, exactly like Claude Code's `statusLine` or a shell rc file. Write there is code execution: keep `~/.pi/agent/statusline-settings.json` under your own account (Pi writes it `0600`), and treat an item copied from the internet with the same suspicion as a shell script from the internet.

## Cache-hit celebration

Whenever one assistant response reaches a prompt-cache hit rate of at least 96%, a temporary module is appended after context usage for about two seconds:

```text
gpt-5.6-sol | pi-extensions:main | 135k/272k | ⚡96%·CACHE·HIT
```

Only the `⚡96%·CACHE·HIT` badge animates, at 60 ms per frame. The existing model, repository, context, separators, worktree, and session-ID rendering do not change.

### Animation styles

`/statusline → Cache celebration` cycles through `off` and five animations:

| Style | Motion |
|---|---|
| `flash` | The whole badge alternates between the theme's two celebration colors (the default, and what shipped before 0.4.0) |
| `wave` | A bright crest sweeps left to right, trailing back into the base color |
| `pulse` | The whole badge ramps between dim and bright on a triangle wave |
| `rainbow` | A full-spectrum gradient rotates along the characters |
| `sparkle` | Random characters flare to the highlight color and decay |

Every style except `rainbow` is derived from the active [theme](#themes)'s two `celebration` roles, so they recolor with the theme — in the `white` theme they stay greyscale. `rainbow` is full-spectrum by design and ignores the palette.

Selecting the row previews it live: the real statusline below the menu loops the badge at 96% so you see the final rendering in context, and the loop stops as soon as you move to another row or close the menu. Choosing `off` keeps your style, so turning the celebration back on restores it.

To compare styles outside pi, or to iterate on their implementations:

```bash
npm run demo:celebrations              # every style on a real statusline
npm run demo:celebrations -- --matrix  # every style against every theme
```

That script imports the shipped styles directly, so editing `celebration-styles.ts` and re-running shows exactly what the extension will render.

The rate is evaluated per provider response as:

```text
cacheRead / (input + cacheRead + cacheWrite)
```

Output and reasoning tokens are excluded because they are not prompt-cache candidates. A zero-token denominator does not trigger the effect, exactly 96% does, and only the displayed percentage is rounded. Another qualifying response during the animation restarts it from frame zero with the new percentage. After expiry, the original statusline is restored exactly.

## Worktree/PR tracking behavior

- Only worktrees directly under the configured worktree root and touched on the active Pi session branch are included. Absolute, `~/`, and `$HOME/` spellings of that root all match.
- Worktree paths appearing only inside Bash heredoc payloads are ignored.
- Merged and closed PR worktrees are hidden.
- State is rebuilt on reload and tree navigation; deleted worktrees are pruned.
- Git state refreshes after each turn; branches without a PR are rechecked every five seconds; existing PR metadata is cached for five minutes.

PR lookups use the `gh` CLI when available and degrade gracefully without it.

## Fullscreen TUI mode

Pi's fullscreen renderer only re-emits terminal rows whose rendered content changed. The worktree and session-ID lines are static for the life of a session, so if their cells ever desync from Pi's row cache — stale transcript text, a process sharing the tty, a stray escape sequence — nothing repaints them and the artifact persists.

To repair that promptly without repeatedly clearing the screen, a one-second sweep changes an invisible marker on the fullscreen footer and requests a targeted differential render. Only the statusline rows compare as changed, so they repaint at most once per second even while the rest of Pi is actively rendering. A 30-second forced full redraw remains as a fallback for corruption outside the footer, throttled to at most one every five seconds and also requested at turn boundaries.

Both repair layers are skipped entirely in regular TUI mode, which reprints its whole block each frame and therefore self-heals. Only the slower forced fallback can drop a scrollback text selection highlight for a single frame.

## Install

```bash
pi install npm:@hank-warren/pi-statusline
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT — see [LICENSE](LICENSE).
