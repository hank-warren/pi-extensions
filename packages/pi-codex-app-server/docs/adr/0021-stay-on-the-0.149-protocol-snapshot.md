# 21. Stay on the 0.149 protocol snapshot, and make unknown methods harmless

Date: 2026-09-17

## Status

Accepted.

## Context

The vendored Codex app-server protocol snapshot in
[vendor/openai-codex-app-server-protocol/](../../vendor/openai-codex-app-server-protocol/) was
generated from `openai/codex` at commit `c9b19de` (2026-08-23) and the server advertises
`CODEX_APP_SERVER_COMPATIBILITY_VERSION = "0.149.0"`. The Codex clients in use here are newer: the
CLI on this host is 0.154.0, and the ChatGPT mobile app tracks its own release train. The question is
whether to re-vendor the snapshot (and bump the advertised version) or stay.

Three separate surfaces get conflated as "the protocol version", and they have different
consequences:

1. **The relay wire contract**, sent as the `x-codex-protocol-version` header on the Remote Control
   WebSocket handshake (`src/remote/relay.ts`).
2. **The schemas** the server validates messages against (`src/protocol/validation.ts`, Ajv over the
   vendored JSON Schema) and the generated method map
   (`src/protocol/generated/codex-methods.ts`).
3. **The advertised version**: `app_server_version` in the enrollment request body, and the
   `userAgent` string in the `initialize` response, both derived from
   `CODEX_APP_SERVER_COMPATIBILITY_VERSION`.

## Evidence

### The relay contract has not moved

`codex-rs/app-server-transport/src/transport/remote_control/websocket.rs` in an `openai/codex`
checkout from 2026-09-16 — newer than the 0.154.0 release installed here — still reads:

```rust
pub(super) const REMOTE_CONTROL_PROTOCOL_VERSION: &str = "3";
```

That is the same `"3"` this server sends. The relay handshake is therefore unchanged between the
vendored snapshot and current Codex.

### The schema delta is additive

Regenerating from the installed CLI (`codex app-server generate-json-schema --experimental`,
`… generate-ts --experimental`, codex-cli 0.154.0) and diffing against the vendored snapshot:

| Measure | Result |
| --- | --- |
| Schema files removed in 0.154 | **0** |
| Schema files added in 0.154 | 20 |
| Changed files | 60, of which **58 are purely additive** |
| Client→server methods | 152 → 159 (7 added, **0 removed**) |
| Client notifications | unchanged |

The two non-additive changes are the `AbsolutePathBuf` definition being inlined in
`ServerRequest.json` and `PermissionsRequestApprovalParams.json` — server→client approval requests
this adapter never sends, because Pi owns permissions.

Of the methods we implement, only `turn/start`, `thread/resume` and `thread/list` changed at all, and
every change is a new optional field or a documentation edit:

- `turn/start`: `turnTrigger`, `toolOutput`, `serviceTierForTurn`, `cyberAccessProgram`
- `thread/list`: `originators`
- `thread/resume`: comment only

### New fields from a 0.154 client validate against the 0.149 schemas

The params objects schemars emits are **open**: `ClientRequest.json` contains exactly two
`additionalProperties: false` occurrences, both inside unrelated enum variants (`AskForApproval`,
`MultiAgentMode`). Feeding 0.154-shaped requests through this server's own validator
(`parseClientRequest`) confirms it:

```text
PASS   turn/start with 0.154-only fields (turnTrigger, serviceTierForTurn, cyberAccessProgram, toolOutput)
PASS   thread/list with originators
PASS   thread/resume
REJECT thread/timeline/list   (0.154-only method)
REJECT turn/settings/update   (0.154-only method)
```

This is covered by a regression test in `test/protocol-forward-compatibility.test.ts`.

### The advertised version is metadata, and changing it forces re-enrollment

Codex sends `app_server_version: env!("CARGO_PKG_VERSION")` in its own enrollment body
(`server_api.rs::enroll_remote_control_server`), and its daemon tooling recovers the version by
parsing the `userAgent` out of the `initialize` response
(`app-server-daemon/src/client.rs`). Nothing observed gates behaviour on the value. Meanwhile
`src/remote/enrollment.ts` treats the stored enrollment as stale when
`storedEnrollment.appServerVersion !== CODEX_APP_SERVER_COMPATIBILITY_VERSION`, so bumping the
constant discards the enrollment and re-registers the host — a fresh pairing, and a stale duplicate
host in the ChatGPT app's list.

Live confirmation that 0.149.0 is accepted: this host is enrolled and paired while advertising
`codex_cli_rs/0.149.0`, and a phone-driven thread and turn completed end to end through it (observed
on upstream 0.1.1, which carries the same constant and the same enrollment code this fork inherits).

### What the clients actually ask for

Neither this server nor the Codex CLI's own `codex-remote-control.service` used to record which
methods arrive over the relay, so "the phone might call a 0.154-only method" was speculation in both
directions. `RemoteControlRelay` now logs every inbound client request at debug level — method name,
client and stream only, never params, because params carry the prompt:

```text
Relay client request {method}  { clientId, streamId, method, hasId }
```

The observed method list from a phone session belongs here; until it is filled in, this decision
rests on the schema and source evidence above, both of which hold regardless of which methods the
phone picks. A `-32601` for a method we do not implement is a normal protocol outcome either way.

## Decision

**Stay on the 0.149.0 snapshot and keep advertising `0.149.0`.** Do not re-vendor now.

The only real defect the newer clients expose is that a method the snapshot has never heard of is
rejected by the *validator*, with a misleading "data/method must be equal to one of the allowed
values" error, instead of producing an ordinary JSON-RPC `-32601`. Re-vendoring would fix that for
exactly the seven methods 0.154 added, and would leave the identical hole open for 0.155 and
everything after it. Handling an unrecognised method gracefully fixes it for every future release,
which is the change worth making instead.

Re-vendor when one of these is true, not before:

- A method this server implements changes shape incompatibly (the diff procedure above is the check).
- The relay's `x-codex-protocol-version` moves off `"3"`.
- The backend or the app starts gating on `app_server_version`, or a wanted feature needs a method
  from a newer snapshot.

When that happens, a re-vendor also costs a re-pairing, so fold it into a change that was going to
re-enroll anyway.

## Consequences

- Clients newer than 0.149 keep working; their extra request fields are accepted and ignored, which
  matches how Codex's own schemars-generated types behave.
- Methods added after 0.149 are answered with a clean `-32601` rather than a validation error (see
  the unknown-method path in `src/protocol/json-rpc-connection.ts`). A client that treats `-32601` as
  "capability absent" — which is how Codex uses it for optional capabilities — degrades gracefully.
- The pairing on this host survives, and the ChatGPT app's host list does not grow a stale duplicate.
- `scripts/generate-codex-method-map.ts` stays in the package (ported from Bun to Node) so a future
  re-vendor is a scripted operation, not an archaeology exercise. It expects the vendored snapshot's
  `.d.ts` layout.

## Re-vendoring procedure, when the time comes

```bash
codex app-server generate-ts --experimental --out /tmp/proto/ts
codex app-server generate-json-schema --experimental --out /tmp/proto/json-schema
python3 /tmp/proto-diff.py packages/pi-codex-app-server/vendor/openai-codex-app-server-protocol/json-schema /tmp/proto/json-schema
```

Review the diff for removed files, removed properties and newly required fields first. Then replace
`vendor/openai-codex-app-server-protocol/{typescript,json-schema}`, rename the generated `*.ts` to
`*.d.ts` (the monorepo typechecks with `NodeNext`, and the generated declarations import without
extensions), update `UPSTREAM.md` with the new commit and date, regenerate the method map, bump
`CODEX_APP_SERVER_COMPATIBILITY_VERSION`, and re-pair the host.
