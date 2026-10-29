# @hank-warren/pi-btw

`/btw <question>` asks a quick side question about the conversation without changing it. The answer streams in yellow and is served mostly from the provider's prompt cache. The model never sees the exchange afterwards, so your next prompt carries on exactly where the conversation was.

```
/btw why did you pick a Map over an object there?
```

## Install

```bash
pi install npm:@hank-warren/pi-btw
```

Try it without installing:

```bash
pi -e npm:@hank-warren/pi-btw
```

Requires pi 0.87 or newer.

## Usage

| Command | Effect |
|---|---|
| `/btw <question>` | Ask a side question. Works while idle and while a turn is still running. |
| `/btw` | Cancel the answer that is streaming. Shows usage when nothing is running. |

- **While it streams**, the answer shows in yellow above the editor. The editor stays usable, and a running turn keeps going underneath.
- **When it finishes**, the question and answer land in the transcript as a yellow card, followed by a dim line such as `cpa/claude-opus-5-5 · 98% cached of 41.2k · 312 out · 3.4s`. The cached share shows whether the cache was actually reused.
- **One at a time.** A second `/btw` while one is streaming is refused; run `/btw` alone to cancel the first.
- **No tools.** The model is told to answer from what is already in the conversation. If it tries to call a tool anyway, the call is not run and the card says which tool it wanted.

The card is a display-only session entry: it shows again when you resume the session, but it is never sent to the model and never counted by compaction.

## How it reuses the cache

Prompt caches match on an exact prefix. pi-btw records the exact transcript of the session's last model request — Pi's final `context_with_system` list, after every other extension's `context` hook, including the prompt and tool system messages — plus every message that finished after it. A side question replays that, adds one user message, and sends it through the same provider with the same:

- session id (providers route their caches on it),
- model, thinking level and thinking budgets, which Anthropic's cache is sensitive to,
- tool declarations (they stay declared even though the answer must not use them, because removing them would move the prefix),
- top-level payload fields: Pi runs `before_provider_request` hooks only on its own agent loop, so pi-btw copies every field outside the conversation from the main request's payload. Rewrites that other extensions made to tool schemas, instructions or reasoning settings carry over without pi-btw knowing what they were.

A question asked mid-turn replays the last request without any tool calls that are still running, because providers reject a tool call with no result.

The request goes over SSE even when the session uses a WebSocket transport, so a provider's connection-scoped continuation stays with the main session.

## Limits

- **Answers are not counted in session stats.** The tokens are real and billed. Their usage is shown on the card and stored in the entry, but Pi's own `/session` totals do not include it.
- **Payload-level rewrites of the conversation are not replayed.** An extension that rewrites the message list in `before_provider_request` (for example, native Codex compaction after a checkpoint) changes the main request in ways pi-btw cannot reproduce. The question still gets answered from Pi's transcript, but that request misses the cache, and for native Codex compaction it does not see the compacted history.
- **Request headers are not replayed.** Header changes from `before_provider_headers` hooks do not carry over.
- **Load order matters.** pi-btw sees the transcript and payload as left by the extensions loaded before it. Anything an extension loaded after it changes is missing from the replay, so list pi-btw last among your packages.
- **Before the first request of a process** (right after `pi --continue`, or after compaction or `/tree`), there is no recorded request yet. pi-btw replays the session branch instead, which matches what Pi would send minus other extensions' `context` hooks. There is also no main payload to copy fields from. Where another extension rewrites the payload, that first question misses the cache: for example, CLIProxyAPI's Codex tool-schema adapter on Responses models showed 0% cached here, against 98% on Claude. One real prompt records a request, and later questions read the cache again.
- **Interactive terminal only.**
