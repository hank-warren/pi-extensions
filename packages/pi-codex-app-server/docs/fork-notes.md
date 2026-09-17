# Fork notes

Working notes for the `@hank-warren/pi-codex-app-server` fork of
[`Lqm1/pi-codex-app-server`](https://github.com/Lqm1/pi-codex-app-server)
(imported at upstream `81f9d1b`, release 0.1.1, 2026-08-24).

## Measurements

Daemon start on oracle-vps (Node 24.19, source-run via `bin/pi-codex-app-server.ts`,
`/tmp/pcas-time.py`, 3 runs, existing enrolment):

| State | process start → endpoint.json | → relay TLS established | first `model/list` |
| --- | --- | --- | --- |
| Imported as-is (no warm-up) | 5.6 s median | 5.7 s median | 52 models, **0 `cpa/*`** |
| With the extension warm-up | 6.2 s median | 6.2 s median | 129 models, **55 `cpa/*`** |

The warm-up itself takes ~2.7 s but is not awaited: the relay connects and clients attach while it
runs, and only catalogue reads (`model/list`, model resolution on `thread/start` and `turn/start`)
wait for it. The 0.6 s the daemon still pays is event-loop contention during startup.

Where the rest of the startup goes, measured phase by phase:

| Phase | Node 24.19 |
| --- | --- |
| Import the config module (pulls in pi-coding-agent) | 1202 ms |
| Import the storage module (drizzle + `node:sqlite`) | 629 ms |
| Open the database and run migrations | 21 ms |
| `ModelRuntime.create` | 23 ms |
| Extension warm-up (concurrent) | 2707 ms |

Startup is dominated by module loading, not by work the daemon chooses to do.

## Node type stripping, not bun

Upstream builds with bun. This fork runs the sources directly, and bun is measurably the faster
loader here — ~776 ms to import the config module against Node's ~1202 ms, and ~19 ms against Node's
~629 ms for the storage module. It is still the wrong choice:

- On a **cold** app-server home, bun's extension load silently produced 108 models against Node's
  130, missing every `anthropic-team` and `openai-codex-team` model that pi-multi-login registers.
  A second run on the same home matched Node. A daemon that shows an incomplete picker on first
  start is the exact failure this fork exists to remove, and 1.7 s of startup does not buy it.
- The monorepo's toolchain is Node: `npm test`, `scripts/validate.py` and `engines.node >= 22.19.0`
  all assume it, and the extension half runs inside pi, which is Node.
- The daemon writes Pi sessions that the Pi TUI resumes. One runtime for both removes a whole class
  of "works in the daemon, not in the TUI" question.

Node's type stripping needs no build step and no loader flag on Node 22.18+, so the only thing bun
would have bought was startup time that a systemd daemon pays once.

## What belongs upstream

Most of this fork is restructuring that upstream should not want: `.ts` import
specifiers, `node:test` instead of vitest, peer dependencies and the pi-resolution
hook, the monorepo's validate/smoke-load registrations. Those exist because the
package lives in a no-build-step monorepo, and they would be a hostile diff
against a repository that builds with bun.

What is worth sending back are the bug fixes underneath, each of which is
independent of that restructuring. Every one has to be translated to upstream's
conventions first: relative imports end in `.js`, tests are vitest, and
`@earendil-works/*` are ordinary dependencies pinned at `^0.84.2`.

| Fix | Why upstream wants it | Translation cost |
| --- | --- | --- |
| Refused handshake is not a clean disconnect (`await once(socket, "open")` in `relay.ts`) | A relay that answers 409 — which it does whenever it still holds the previous session for a server id — resets the backoff instead of growing it, so a refusing relay is retried once a second forever. Observed live here. | None; the change is self-contained. |
| `errorListener` drops its second argument (`json-rpc-connection.ts`) | `json-rpc-2.0` passes the failure itself there. Logging only the summary string is why a failed remote turn arrives as one sentence with no name, stack or cause. | Small: `asError` is one new file, or inline it. |
| `model/list` throws on a model without `contextWindow` (`model-catalog.ts`) | Pi's type says the field is required, but a provider registered by an extension with `models: [{ id }]` has none, and `model/list` returns the whole catalogue in one response — so one such model empties the picker. | None. |
| Unknown methods answer `-32601`, not `InvalidParams` (`json-rpc-connection.ts`) | A client newer than the vendored snapshot asks for methods the schema has never seen; today they are rejected as malformed with a schema dump. Codex treats `-32601` as "capability absent". Fixes every future release, not just 0.154's seven new methods. | None. |
| Load extensions once at startup (`pi-model-runtime.ts`) | Extension-provided providers are invisible until some session loads extensions, so a freshly started daemon shows a short picker and rejects its own models. 52 models → 129 here. | Small: upstream passes `refreshOnCreate: true`, which this fork drops for pi 0.84 compatibility. Keep it upstream. |
| Log relay requests by method name (`relay.ts`) | First thing worth knowing when a remote turn misbehaves, and the only way to learn which methods a ChatGPT client actually calls. Params stay out of the log. | None. |

**Not the autostart default.** This fork turns it off because a systemd unit owns
the daemon here; upstream's on-by-default suits a laptop where the TUI is the
only way one ever starts. It is already configurable through
`PI_CODEX_APP_SERVER_AUTOSTART`, so a pull request flipping it would be a policy
argument with no bug behind it. If anything goes upstream on this, it is the
observation that an autostarted daemon competes with an externally managed one
for the same state directory — better as an issue than a patch.

## Relay reconnect, reviewed against a forced disconnect

The daemon's socket to the ChatGPT relay was killed with `ss -K` while it was
connected, twice: once on the imported code and once after the fix below.

On the imported code the daemon did come back, but for the wrong reason. A
refused handshake reaches the relay as a *socket error*, not as a failure of the
read loop, so the attempt ended by falling out of the loop and was counted as a
clean disconnect: the backoff reset to 1 s, and the 409 was reported as an
`ERROR` even though it is the expected answer while the relay still holds the
previous session for this server id. A relay that kept refusing would have been
retried once a second indefinitely.

Now the connection is only "established" once the WebSocket has opened
(`await once(socket, "open")`), so a refused handshake propagates, earns the
exponential delay, and is logged once with that delay:

```json
{"level":"WARN","message":"\"Unexpected server response: 409\"",
 "properties":{"reconnectDelay":2000,
   "error":{"name":"Error","message":"Unexpected server response: 409","stack":"Error: Une…"}}}
```

Observed sequence after the kill: `INFO relay disconnected; reconnecting in
1000 ms` → attempt refused with 409 (`DEBUG` socket error, `WARN` with
`reconnectDelay: 2000`) → connected again, about four seconds after the kill,
with no intervention and no `ERROR` line in the run.

## Error reporting

`json-rpc-2.0` calls its `errorListener` with a summary string *and* the failure
itself; upstream logged only the string, which is why a failing remote turn
arrived in the log as one sentence with no name, stack or cause. Everything that
reports a failure now goes through `asError` in `src/logging/error-report.ts`,
and the logger serialises `{ name, message, stack }` — the WARN line above is a
live example. This replaces the hand-patched `dist/cli.js` that was carrying the
same fix on this host; that install is gone.

## Monorepo adaptation

- No build step. `src/` is loaded straight from TypeScript: by pi's loader for the
  extension half (`index.ts` → `src/extension/index.ts`), and by Node's built-in
  type stripping (>= 22.18) for the daemon/CLI (`bin/pi-codex-app-server.ts`).
  Upstream's `bun build` bundle and `dist/` are gone.
- Relative imports use `.ts` extensions (upstream used `.js`); the vendored
  ts-rs declarations were renamed `*.ts` → `*.d.ts` so `tsc --skipLibCheck` accepts
  their extensionless imports, and `src` keeps importing them as `.js`.
- `@earendil-works/*` are peer dependencies (pi provides them). The daemon is a
  separate node process, so `bin/pi-resolve-hooks.ts` re-resolves those bare
  specifiers from inside the host pi install (`bin/pi-root.ts` finds it from
  `PI_CODEX_APP_SERVER_PI_ROOT`, else the `pi` on PATH; the extension passes its
  own `process.argv[1]`-derived root when it spawns the daemon). The daemon
  therefore runs the same pi version as the host TUI, and the sessions it writes
  stay resumable there.
- Tests were ported from vitest to `node:test` so the monorepo's single
  `npm run test:unit` covers them.
