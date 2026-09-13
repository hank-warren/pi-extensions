# pi-codex-compaction

> **Fork.** Based on [`@ogulcancelik/pi-codex-compaction` 0.1.5](https://github.com/ogulcancelik/pi-extensions/tree/451e49da38e117f11f4b8e622c2bc432444f8a3a/packages/pi-codex-compaction) by Can Celik (MIT). Adds CLIProxyAPI support while retaining direct Codex compaction and upstream checkpoint compatibility. Do not load this fork and the upstream package together: both would handle the same compaction lifecycle.

Native OpenAI Codex compaction integrated into Pi's existing `/compact`, context-threshold, and overflow-recovery lifecycle. Instead of summarizing older messages as text, the extension requests an opaque encrypted checkpoint and stores it in Pi's compaction entry.

Pi 0.84.4 or later is recommended. Older releases retain upstream's compatibility guard for safe mid-run compaction.

## Install

Remove the upstream package before installing this fork:

```bash
pi remove npm:@ogulcancelik/pi-codex-compaction
pi install npm:@hank-warren/pi-codex-compaction
```

Restart Pi after changing packages. A git install of this repository already includes the fork; do not also install its npm package.

To try the local package without installing it, with other extensions disabled:

```bash
pi -ne -e ./packages/pi-codex-compaction
```

## Supported models

| Route | Eligibility | Compaction endpoint and authentication |
|-------|-------------|----------------------------------------|
| Direct Codex | `provider: openai-codex`, `api: openai-codex-responses` | Codex Responses endpoint, ChatGPT OAuth token and account ID |
| CLIProxyAPI | `provider: cpa`, `api: openai-responses`, GPT-5.6 or GPT-6 family | The model's base URL plus `/responses`, using the provider's resolved API key and custom headers |

CPA works with [`@hank-warren/pi-cliproxyapi-provider`](https://github.com/hank-warren/pi-extensions/tree/main/packages/pi-cliproxyapi-provider). It keeps its normal `openai-responses` routing; do not switch its API or credentials to direct Codex. Namespaced model IDs such as `team/gpt-6-astra` are supported. Claude, other model families, and unrelated Responses providers are not opted in.

The proxy must forward `X-Codex-Beta-Features: remote_compaction_v2`, accept a trailing `{"type":"compaction_trigger"}` input item, return one streamed `compaction` item with `encrypted_content`, and accept that item on follow-up requests. Generic Responses compatibility alone does not establish this capability. Native compaction creation and encrypted-only replay were verified on CLIProxyAPI v7.2.157 with GPT-6 Astra.

### Renamed CPA providers or disabling CPA support

Configure the global file `~/.pi/agent/pi-codex-compaction.json` (under `PI_CODING_AGENT_DIR` when set):

```json
{
  "cpaProviders": ["cpa", "my-cpa"]
}
```

The default is `["cpa"]`. Set `"cpaProviders": []` to disable CPA support. Only list providers you know route the supported GPT models through a compatible CLIProxyAPI instance. This setting is global-only: project configuration cannot opt a provider in. Reload Pi after changes. Direct Codex support is independent of this list.

## How it works

1. Pi triggers `session_before_compact`. On Pi 0.84.4+, Pi owns timing and continuation, including compaction between tool turns.
2. The extension reconstructs the active Responses history, reusing any previous native checkpoint, and appends a `compaction_trigger`.
3. It requests compaction through the selected model's transport, preserving provider authentication and custom headers. CPA manages upstream OAuth itself.
4. The returned opaque checkpoint and recent user messages are stored in `CompactionEntry.details`. Pi's required summary string is only a local marker.
5. Follow-up requests replace the conversation with the checkpoint plus new messages, advertise `remote_compaction_v2`, and preserve the finalized system/developer prompt. The local marker and TUI status entries are never sent to the model.

Interactive sessions display durable `OpenAI compaction running…`, completion, and failure markers. No separate command or model-facing tool is added.

## Failure and persistence behavior

- **Fail-closed compaction:** an eligible native request that fails cancels Pi compaction and leaves the previous history intact. There is no silent text-summary fallback.
- **Branch-local state:** resume, forks, tree navigation, and repeated compaction use the newest checkpoint on the active branch. Repeated compaction replaces the previous opaque item rather than nesting it.
- **Model-bound checkpoints:** continuing with another eligible native model is blocked. CPA checkpoints also bind to the normalized Responses endpoint, so reconfiguring the same provider name to another endpoint does not replay opaque history there. Existing upstream direct-Codex checkpoints retain their original format and keys.
- **Provider switching is not a handoff:** unsupported providers receive neither the checkpoint nor its local marker; they can only see messages retained outside it. No textual summary exists to transfer the compacted history. Return to the original model/provider/endpoint to continue with that checkpoint.
- **Account routing:** CPA selects upstream accounts; the extension does not pin them. A two-account failover canary passed on CLIProxyAPI v7.2.157 with GPT-6 Astra: an injected quota-exceeded response moved an affinity-bound session from account A to B, which compacted A's history (including encrypted reasoning), replayed A's existing encrypted checkpoint, and re-compacted it while preserving a synthetic fact. Replay checks supplied no plaintext copy of that fact. This verifies the tested accounts/model/version, not a permanent upstream portability guarantee; repeat the canary when changing the deployment.

## Compaction settings

On Pi 0.84.4+, configure timing in Pi's global or project `settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

The threshold is `contextWindow - reserveTokens`. Manual `/compact` is available even with automatic compaction disabled.

On older Pi versions only, upstream's fallback defaults to `autoCompact: true` and `thresholdRatio: 0.9`. The global `pi-codex-compaction.json` and trusted project `.pi/pi-codex-compaction.json` can override those two legacy settings. The fallback stops before the next provider request, compacts after settling, and resumes only when necessary. It disables itself on Pi 0.84.4+.

## Data handling and limitations

The current conversation goes to the selected Codex endpoint, directly or through the configured CPA proxy. OpenAI's opaque `encrypted_content` is stored in the local session JSONL and replayed on compatible requests. Treat session files as private conversation data, not portable textual summaries.

Pi does not expose a finalized provider payload during `session_before_compact`. The extension mirrors upstream's message conversion, combines it with the most recently observed request shape, and uses Pi's current system prompt for the compaction request. Extensions that independently rewrite provider payloads can create order-dependent behavior. On CPA follow-up requests, finalized system/developer input messages are preserved when the checkpoint replaces conversation history.

## Development canary

Before release, run a real Pi TUI session with this fork and the CPA provider, using a scratch agent directory and synthetic data only. Confirm:

1. Diagnostic-free startup and normal CPA replies.
2. Manual `/compact` shows running/completion markers and writes native details.
3. Follow-up recall preserves facts supplied by an assistant/tool, not just retained user messages, and still follows the system prompt.
4. A second compaction replaces the checkpoint and conversation continues.
5. Exit, resume the scratch session, and recall the same facts.
6. Cancel compaction with Escape; no successful checkpoint should be appended, and another request should work.
7. Change to another eligible model; replay is blocked rather than forwarding the opaque checkpoint.
8. For multi-account CPA deployments, test failover with two distinct upstream accounts in an isolated proxy instance. Keep the client session ID, model, and endpoint fixed; inject quota exhaustion for A without exhausting or disabling production accounts. Verify that B can compact A's encrypted reasoning, replay A's existing checkpoint, and re-compact it. Recall must use the checkpoint alone, without a plaintext copy of the expected fact. Use access-token-only test credentials so the canary cannot rotate production refresh tokens.

Also exercise the actual context-threshold boundary with a tool-driven turn, and direct Codex if its lifecycle or transport changes. Never use production sessions as fixtures or retain copied credentials after a canary.

## Attribution

Copyright (c) 2026 Can Celik. Fork changes by Hank Warren. See [LICENSE](LICENSE). The upstream regression suite is adapted to the repository's hermetic Node test runner and shared Pi fakes.
