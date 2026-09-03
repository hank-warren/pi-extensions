# @hank-warren/pi-statusline

## 0.7.3

### Patch Changes

- d0c46a5: Resolve `auth.json`, the usage cache and `statusline-settings.json` through Pi's agent directory (`PI_CODING_AGENT_DIR`) instead of a hardcoded `~/.pi/agent`. Behaviour is unchanged for a normal install; a session started with a scratch agent dir no longer reads the real credentials or writes the real usage cache. `engines.node` now states Pi's own floor, `>=22.19.0`.

## 0.7.2

### Patch Changes

- 7f2143a: Make the subscription usage meters accurate as well as prompt. Three changes to how the poller treats each endpoint and its own cache, following the ten-second tick shipped in 0.7.1.

  **Codex gets its own sixty-second interval.** Both endpoints shared one five-minute spacing, written for the stricter of the two. OpenAI's own Codex CLI polls its usage endpoint every sixty seconds and independent tools converge on the same figure, so the Codex meter had been five times more conservative than the vendor's own client for no reason beyond sharing a constant. Anthropic's endpoint, which rate-limits far harder, keeps the five minutes it needs.

  **A `Retry-After` is now honoured.** Any 429 previously got a flat fifteen-minute backoff, ignoring the header saying when to come back; a provider asking for sixty seconds now gets sixty seconds, and one asking for an hour is no longer cut short by our guess. Both forms are accepted, delta-seconds and HTTP-date. A value that is not in the future is discarded rather than clamped, because Anthropic's usage endpoint is widely reported to answer `retry-after: 0` while still refusing requests — obeying it literally would retry straight back into the limit that produced it. The flat window remains the fallback for a 429 that says nothing.

  **Cached values expire at their window boundary, not just by age.** Each cache entry now records the soonest moment any of its windows rolls over, from Anthropic's `resets_at` or Codex's `reset_at`/`reset_after_seconds`. Once that moment passes the stored percentages describe the window that just _ended_ — not merely stale but wrong, and invisible to any age-based expiry. Such a value is no longer adopted from the shared cache or kept as a last-known-good, and its account skips the poll interval so the post-reset numbers appear promptly. A boundary is answered exactly once rather than on every tick: a failed poll leaves the boundary in the past, so an unconditional override would re-poll continuously for as long as the failure lasted — a 429 sets a backoff that stops that, but a 500 or a timeout does not. An active rate-limit backoff still outranks a boundary, and a value carrying no boundary — which is what an entry written by an earlier statusline looks like — never expires this way.

  The cache file stays compatible in both directions: the reset boundary is an additive field that older readers ignore, and an entry without one behaves exactly as before.

## 0.7.1

### Patch Changes

- 950c926: Tick the subscription usage meters on a clock instead of on turn boundaries. The tracker only refreshed from session start, the end of a turn, and a model switch, while the poll gate that spaces requests is host-wide and five minutes wide. The moment a meter actually moved was therefore the first turn in this session ending more than five minutes after any pi process on the host last polled that account — which made updates look arbitrary, and froze an idle session's numbers indefinitely while the five-hour window was visibly recovering.

  `UsageTracker` now owns an unref'd ten-second tick, started with the footer and stopped with the footer, with the usage setting, or at session shutdown. Request volume is unchanged, because a throttled refresh already issues no request: it reads `auth.json` and the shared cache, publishes whatever another process has already fetched, finds the gate closed and returns. The tick costs two small local reads and buys the two things the turn-driven cadence could not — an idle session's meters keep moving, and a sibling process's fresh values are adopted within one tick rather than waiting for this session's next turn to end. The poll itself now also fires when the five-minute window opens rather than at the first turn to end after it.

  Nothing about the meters' appearance, the poll interval, the rate-limit backoff or the shared cache format changes.

## 0.7.0

### Minor Changes

- 70c8ef9: Add an optional provider segment. A new `Provider` toggle in `/statusline` renders the active model's provider id between the model and the directory (`claude-opus-5 | anthropic-team | pi-extensions:main | 0/1.0m`), so a `pi-multi-login` alias names the login actually spending — something a model id never carries. It is off by default, has its own colour role in every theme, and is omitted entirely when the model reports no provider.

## 0.6.0

### Minor Changes

- 01994c7: Show the Codex 5-hour window alongside the weekly one. Codex has restored a 5-hour limit next to the weekly one on some plans, and the parser already received that window and deliberately discarded it — it kept only the largest window spanning at least a day — so a real limit went unshown. Both are now rendered like the Claude meter: 5-hour, dim separator, weekly.

  Which windows exist is a property of the account, so the two slots are filled from each window's span rather than from the plan name: the shortest sub-day window fills the 5-hour slot and the longest multi-day window fills the other. A plan with no 5-hour limit keeps rendering its single weekly number, and a free plan's lone 30-day window keeps rendering in the same place. A payload carrying only a sub-day window now reports it as the 5-hour value instead of mislabelling it as weekly.

  The host-wide usage cache changes additively: an entry written by an earlier version has no 5-hour value and renders weekly-only until the next poll, and an earlier version ignores the extra one.

## 0.5.0

### Minor Changes

- 0e9400e: Point each subscription usage meter at the account behind the main model, so additional provider logins report the headroom actually being spent. Families the main model does not belong to keep showing their base account, and a login used only for background work is never polled.

  The host-wide usage cache is now keyed by credential id rather than by provider family. Keyed by family, two sessions on two different Anthropic accounts each looked like an account switch to the other, evicting each other's values and re-polling every cycle. Cache files written by earlier versions are discarded, costing one extra poll on upgrade.

## 0.4.2

### Patch Changes

- 1e25d6b: Guard against a setting being added without being registered for persistence. `SETTING_KEYS` feeds the per-key diff behind every save, so a key missing from it applied live and then silently failed to persist. Omitting one is now a `tsc` error naming the key, plus a test asserting the list matches `defaultSettings()`. Adds an "Adding a setting" checklist and the cross-version compatibility rules to the README.

## 0.4.1

### Patch Changes

- 2dbfc7a: Stop settings saves from clobbering the file. Sessions load settings once at startup and used to persist their entire in-memory snapshot, so changing any row in a session that started before an edit silently reverted that edit — losing hand-written config and other sessions' changes, and collapsing the file to `{}` because serialization is sparse. Saves now write only the keys a change actually touched, merged over the current file contents, and opening `/statusline` re-reads the file first.

  Also moves the **Cache celebration** row after **Subscription usage** so the menu follows the order elements render in.

## 0.4.0

### Minor Changes

- c5e6e34: Add five cache-celebration animation styles — `flash` (the previous behaviour, still the default), `wave`, `pulse`, `rainbow`, and `sparkle`. The `/statusline` **Cache celebration** row now cycles `off` plus each style instead of `on`/`off`, and selecting the row loops the badge live in the statusline below so you can compare them in place. Choosing `off` preserves the selected style.

  Every style except `rainbow` derives from the active theme's two `celebration` colours, so it recolours with the theme. `npm run demo:celebrations` previews all of them, and `-- --matrix` compares every style against every theme.

  Also fixes `isThemeName` accepting prototype keys such as `__proto__`.

## 0.3.0

### Minor Changes

- 0e6c204: Add a `/statusline` settings menu for choosing a theme, toggling every footer element, setting the worktree-tracker root, and managing repo aliases. Settings persist to `~/.pi/agent/statusline-settings.json` and apply live.

  Themes: `default` (unchanged), `dracula`, `github-dark`, `catppuccin-mocha`, and `white`. A theme maps eleven colour roles, so switching recolours every element without changing the rendered text.

  Breaking: the built-in repo aliases and the automatic `platform-` prefix strip are gone — they were hardcoded to one machine. Repository names now render verbatim; add your own pairs under `/statusline → Repo aliases`.

## 0.2.4

### Patch Changes

- 6e3dc47: Raise the neon cache-wave celebration threshold from a 90% to a 96% prompt-cache hit rate, so the badge marks genuinely exceptional responses.

## 0.2.3

### Patch Changes

- cf12677: ship CHANGELOG.md in the published tarball
