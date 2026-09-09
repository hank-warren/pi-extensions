# @hank-warren/pi-muxr

The [muxr](https://github.com/hank-warren/muxr) bridge client for Pi. It
projects a session's active branch and live stream to the muxr mobile gateway
over a capability-authenticated Unix socket.

It is a **read** extension. It registers no tool and no command, so the model
can never invoke it, and every event handler returns `undefined`, so it can
never rewrite what Pi persists. It never touches Herdr.

Without its CLI flags it does nothing at all: no socket, no file reads, no
state. Loading it into an ordinary session is inert.

## Install

```bash
pi install npm:@hank-warren/pi-muxr
```

## How it is launched

The muxr bridge starts Pi with the flags below. There is no environment
variable and no default path for any of them — an absent flag leaves the
extension inert rather than resolving somewhere plausible.

| Flag | Meaning |
|---|---|
| `--muxr-bridge-socket <path>` | Unix socket the bridge listens on |
| `--muxr-capability-file <path>` | `0600` file holding a one-use 256-bit hex capability |
| `--muxr-registration-id <id>` | Identifies this registration in the handshake |
| `--muxr-binding-file <path>` | JSON file with the Herdr side of the target binding |
| `--muxr-experimental-chat-write` | One of the three chat-write gates (see below) |

The bridge is the sole listener; this extension is the client. Registration is
a mutual HMAC-SHA256 handshake over
`muxr-bridge-v1|role|protocol|bridgeEpoch|registrationId|helloNonce|challengeNonce`,
keyed by the raw bytes of the hex capability. The capability is one-use and
cannot authorise a reconnect: after the bridge goes away, re-registration reads
a freshly written capability file.

## What it publishes

- **Snapshots** — the active branch via `buildContextEntries()`, bounded to
  2048 entries and 4 MiB, oldest-first truncation, with `truncated: true`
  whenever anything was dropped *or* a compaction marker is present.
- **Stream events** — `message_start` / `message_update` / `message_end` with
  provisional ids, plus `tool_execution_start` / `tool_execution_end`.
- **`message_reconciled`** — provisional stream ids mapped to persisted entry
  ids after each settle. Matching is by role and position, never by text: a
  `message_end` handler in another extension may legitimately rewrite a message
  before Pi persists it.

The snapshot is authoritative and events are hints. After a gap or a reconnect,
rebuild from the snapshot rather than patching.

Everything crossing the socket is untrusted data. Text is copied, never
interpreted as markup.

## Chat write is experimental, disabled, and gated three ways

Sending a message from the phone is a **prototype**. Pi 0.85.1 has no
target-bound acceptance boundary — `sendUserMessage` returns `void`, the loader
discards it, and no event correlates a result to a request — so an
extension-level implementation cannot guarantee that a message landed where the
caller intended. See [UPSTREAM-PROPOSAL.md](UPSTREAM-PROPOSAL.md) for the API
that would fix this properly.

**All three of these must be true, or chat write stays off and every snapshot
advertises `disabled.chatWrite: true`.** When all three hold, snapshots
advertise `disabled.chatWrite: false` and `chat_write` requests are accepted.
The decision is re-sampled per snapshot and per request, so revoking consent is
visible on the wire without restarting Pi:

1. `"muxr.experimentalChatWrite": true` in Pi's settings — the user's opt-in;
2. the `--muxr-experimental-chat-write` CLI flag — consent visible in the
   controlled process's own argv;
3. the bridge asks for the `chatWrite` capability during registration.

They are re-checked on every request, so removing the setting takes effect
immediately without restarting Pi.

```json
// ~/.pi/agent/settings.json
{
  "muxr.experimentalChatWrite": true
}
```

Pi exposes no settings API to extensions, so this key is read from
`settings.json` directly (the same approach `pi-auto-permissions` uses for its
shell settings). **The key survives Pi's own settings writes:**
`SettingsManager.persistScopedSettings` re-reads the file and merges only the
fields it explicitly modified, so changing anything through `/settings` or
Ctrl+S leaves unknown `muxr.*` keys intact. Verified against Pi 0.85.1's
shipped `dist/core/settings-manager.js`. A project-local `.pi/settings.json`
can override the key **only when the project is trusted**, so opening an
untrusted repository can never grant a write capability.

### Three outcomes, one of which is `unknown`

A `chat_write` request carries `expectedLeafId` and
`expectedRuntimeGeneration`. Both are compared before sending, and a mismatch,
a busy session, or a second concurrent request is refused **before** anything
is sent — a `rejected` result always means nothing was delivered.

After sending, the outcome is inferred from side effects. **Correlation never
compares message text** — that mechanism is rejected by muxr's design register,
and it had a concrete failure: the desktop user typing the same text at the same
parent inside the window was claimed as ours, so one prompt silently became two.

Instead a send is claimed by leaf transition. It is `accepted` only when all of
these hold: the leaf never moved between the preflight and the first user-role
`message_start` after the send, and exactly one user entry hangs off that leaf
(walked across *all* session entries, so a sibling on a forked branch counts).

| State | Meaning |
|---|---|
| `accepted` | Exactly one user entry hangs off the expected leaf and our own `message_start` was seen while the leaf was unchanged; `entryId` identifies it |
| `rejected` | Refused during preflight; **nothing was sent** |
| `unknown` | The send may or may not have landed (`leaf_moved`, `ambiguous_parent`, `no_persisted_entry_within_window`, `connection_closed`, `session_shutdown`) |

A request is also refused before sending when its `registrationId`,
`bridgeEpoch` or `protocol` does not match the live registration, when the
expected leaf already has a user child, when the session is busy, or when
another request is in flight.

A re-sent `requestId` **replays the stored outcome and never sends again**; the
extension is the only party that can see the duplicate arrive.

**`unknown` is a real state, not an error.** The compare and the send are not
atomic, so it is unavoidable. A client must surface it to the user and let them
decide; it must never retry automatically, because a retry after an `unknown`
is how one prompt becomes two. This extension never retries.

How common is `unknown`? A canary against a real Pi with no model configured
produced exactly it: `sendUserMessage` returned normally, Pi failed the send
and reported `extension_error` on its own output channel, and the extension —
which cannot see that channel — had to wait out its observation window before
reporting `unknown`. Treat it as an expected outcome, not a rare one.

## Wire contract

`src/contracts.ts` is duplicated from `proof/lib/contracts.mjs` in the muxr
repository at commit `e5281de05f8cebdca1ee3926ef2fd3f47c47ae57`. This package
cannot import from that repository, so the two copies must change together: a
divergence is a protocol break that neither repository's tests would catch
alone.

Framing is newline-delimited JSON, one envelope per line, UTF-8. A single line
over 1 MiB closes the connection with `frame_too_large`; retained inbound
envelopes are capped at 4 MiB and close with `buffer_overflow`. The reader
never throws: a fault in a `net` callback would be an uncaught exception that
JSON and print mode do not handle, and it would terminate the very session this
extension exists to observe.

## License

MIT
