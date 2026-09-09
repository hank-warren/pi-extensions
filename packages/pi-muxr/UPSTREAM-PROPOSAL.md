# Upstream proposal: a target-bound acceptance boundary for extension-sent messages

This package ships a chat-write prototype that **cannot be made safe** with the
API Pi 0.85.1 offers. This document states the gap precisely, proposes the
smallest upstream change that closes it, and records why the workarounds an
extension can reach for are worse than the honest `unknown` this package
reports.

## The gap

An extension that sends a message on behalf of a remote client needs to answer
one question: *did the message I sent land on the target I meant, and which
entry is it?* Pi 0.85.1 provides no way to answer it.

`sendUserMessage` is declared to return nothing:

```ts
// $PI/dist/core/extensions/types.d.ts:980-983
sendUserMessage(content: string | (TextContent | ImageContent)[], options?: {
    deliverAs?: "steer" | "followUp";
    expandPromptTemplates?: boolean;
}): void;
```

There is no parameter expressing the caller's expected target, no return value
identifying what was accepted, and no event correlating a result back to a
caller's request. The muxr proof's source gate establishes the same conclusion
from the loader and session sources rather than by probing behaviour:
`hank-warren/muxr`, `proof/test/source-gate.test.mjs` at commit
`e5281de05f8cebdca1ee3926ef2fd3f47c47ae57`, which reports `chatWrite: disabled`
in `proof/report/proof-report.json`.

### Observed live, not theorised

A canary against a real Pi 0.85.1 in `--mode rpc`, with all three consent gates
open, makes the gap concrete. The extension sent a message; Pi failed it and
**said so on its own output channel**:

```json
{"type":"extension_error","extensionPath":"<runtime>","event":"send_user_message",
 "error":"No API key found for the selected model...."}
```

`sendUserMessage` itself did not throw — it returned `void`, as declared. Pi
knew the send had failed, and the extension had no way to learn it: that error
is written to the RPC/JSON output stream, not delivered to any extension event
handler. The extension could only wait out its observation window and report:

```json
{"requestId":"canary-req-1","state":"unknown","reason":"no_persisted_entry_within_window"}
```

So the failure mode is not hypothetical: **Pi already has the information the
caller needs, and no supported channel carries it back.** A remote user waited
ten seconds to be told "unknown" about a send that Pi had already definitively
rejected. Any correlation signal an extension can reach is inference from side
effects.

The consequence is a window nothing can close:

```
  extension                     Pi / desktop user
  ---------                     -----------------
  read leaf L
  compare L to expectation
                                user types; leaf becomes L'
  sendUserMessage(text) ------->
                                message is accepted at L'
  observe...                    (which entry? was it ours?)
```

The compare and the send are two separate operations with no lock between
them. A remote client that cannot distinguish "landed where I meant", "landed
somewhere else", and "did not land" cannot safely offer a send button — and a
client that retries an unconfirmed send turns one prompt into two.

## What this package does instead, and why it is not enough

`src/chat-write.ts` implements the best approximation available:

1. **Preflight.** Compare the caller's `expectedLeafId` with
   `sessionManager.getLeafId()` and `expectedRuntimeGeneration` with the
   extension's own generation. Refuse on mismatch, refuse when the session is
   not idle, and refuse a second concurrent request.
2. **Send.** Call `pi.sendUserMessage(text)`. The `void` return says nothing.
3. **Observe.** Watch `message_start` for a user message whose text matches,
   then resolve identity from persisted entries by matching `parentId` against
   the expected leaf. Report `accepted` with the entry id.
4. **Give up honestly.** If the leaf moved with no matching entry, or nothing
   appears within a bounded window, report `unknown` and stop. Never retry.

Every step after the preflight is inference from side effects. The residual
defects are real and are not hidden:

- **The preflight is advisory.** It narrows the window; it does not remove it.
- **`unknown` is unavoidable and common enough to matter.** It is a first-class
  state the client must show the user, not an error to swallow.
- **Correlation uses text.** Matching `parentId` *and* text is the strongest
  signal available, but text is not identity: two identical prompts at one
  parent are separated only by claiming entry ids in order, which is a
  heuristic, not a guarantee.
- **Concurrency is refused rather than solved**, because no evidence available
  to an extension can tell two in-flight sends apart.

## The proposed API

One method and one event. The method performs the compare and the accept
**inside** the same critical section Pi already holds when it appends to a
session, so no caller-visible window exists:

```ts
interface AcceptUserMessageRequest {
  /** Caller's request id, echoed on the result and the receipt event. */
  requestId: string;
  /** The leaf the caller believes it is appending to. */
  expectedLeafId: string;
  /** Optional: refuse if the session id differs (a session was replaced). */
  expectedSessionId?: string;
  content: string | (TextContent | ImageContent)[];
  /** Same semantics as sendUserMessage; absent means "only when idle". */
  deliverAs?: "steer" | "followUp";
}

type AcceptUserMessageResult =
  | { accepted: true; requestId: string; entryId: string; leafId: string; sessionId: string }
  | { accepted: false; requestId: string; reason: AcceptRejectionReason };

type AcceptRejectionReason =
  | "leaf_mismatch"      // expectedLeafId is no longer the leaf
  | "session_mismatch"   // expectedSessionId is not the current session
  | "busy"               // a turn is running and no deliverAs was given
  | "shutting_down";

// On ExtensionAPI:
acceptUserMessage(request: AcceptUserMessageRequest): Promise<AcceptUserMessageResult>;
```

Two properties do the work:

1. **Atomic compare-and-append.** The `expectedLeafId` check and the append
   happen under whatever lock Pi already uses to append an entry. If the leaf
   moved, nothing is appended and the caller is told so. This is the
   compare-and-swap that the current two-step cannot express.
2. **Identity in the reply.** The returned `entryId` and `leafId` remove the
   entire observation-and-correlation layer. No text matching, no bounded
   window, no claimed-id bookkeeping.

The companion event lets a client that lost the connection mid-call recover
without re-sending:

```ts
pi.on("user_message_accepted", async (event, ctx) => {
  // event.requestId, event.entryId, event.leafId, event.sessionId
});
```

With `requestId` echoed on a durable event, a reconnecting client reconciles by
asking "was my request id accepted?" instead of guessing from the transcript —
which is what makes exactly-once delivery achievable at all.

### Why a receipt event as well as a return value

A `Promise` resolves into a process that may be gone. The remote client's
connection can drop between the send and the reply, and on reconnect the only
question that matters is whether `requestId` was accepted. An event carrying
the same `requestId` makes that answerable from the session itself.

## Rejected alternatives

- **Return a value from `sendUserMessage`.** Source-compatible, but the
  extension loader discards handler and API return values today, and the name
  promises fire-and-forget. A new method leaves existing callers alone.
- **Expose the session lock to extensions.** Far larger blast radius: any
  extension could stall the agent loop.
- **A `before_user_message` veto hook.** Lets an extension block, but still
  provides no identity for what was accepted, so the correlation problem
  survives unchanged.
- **Make the extension poll the transcript.** What this package does now. It is
  inference, not acceptance.
- **Route the existing `extension_error` to an event handler.** This would fix
  the observed failure case above and is strictly smaller than the proposal,
  but it only reports *failures*: a successful send still returns no entry id,
  so the correlation layer and the `unknown` state would both survive. Worth
  doing regardless; not a substitute.

## What we would delete on adoption

`src/chat-write.ts` would shrink to a single `acceptUserMessage` call plus
error mapping: the observation window, `findUserEntry`, the claimed-id set, the
concurrency refusal, and the `unknown` state would all be removed. The three
consent gates (setting, CLI flag, bridge-requested capability) would stay —
they express user intent, not a protocol deficiency.

## Status

Prototype only, shipped disabled by default behind three independent gates.
Chat write is **not** part of the muxr baseline: the read projection is, and
the mobile client's send path stays on explicit terminal control until an API
of this shape exists.
