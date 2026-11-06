# Architecture

How pi-claude works. For installation and usage, see [README.md](README.md).

## Shape

The extension registers a Pi provider (`claude-sub`) whose stream
implementation drives Claude Code's `stream-json` mode. Pi owns the conversation,
approvals, compaction and tool execution; Claude Code owns authentication and
talks to the Anthropic API.

```
Pi agent loop ──streamSimple──▶ ClaudeSessionManager ──stdin/stdout──▶ claude -p (one per Pi session)
                                       ▲                                   │ tools/call
                                       └──── Unix socket ◀── mcp-bridge.mjs ◀┘
```

| Module | Role |
|---|---|
| `src/provider.ts` | Provider registration, ambient auth via `claude auth status`, model discovery |
| `src/claude-cli.ts` | Executable lookup, login/subscription checks, worker environment, control-request model probe |
| `src/model-catalog.ts` | Claude Code catalog rows to Pi models; fallback snapshot |
| `src/stream.ts` | Request preparation (prompt, tools, effort, fingerprint) and Anthropic event translation |
| `src/manager.ts` | Per-session routing: continue, answer parked tools, fork, synthesize |
| `src/worker.ts` | One Claude Code process: launch flags, event reader, parked tool calls |
| `src/bridge.ts`, `src/mcp-bridge.mjs` | MCP server Claude Code launches; relays to the extension over a private socket |
| `src/transcript.ts` | Normalizing Pi history, prefix hashes, stdin frames, synthesized transcript entries |
| `src/cleanup.ts` | Registry and retention of Claude Code sessions the extension created |

## Claude Code worker

Each worker is

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --replay-user-messages --model <id> --tools ""
  --setting-sources "" --strict-mcp-config --disable-slash-commands
  --permission-mode bypassPermissions --system-prompt-file <pi prompt>
  --system-prompt-snapshot off --mcp-config <bridge> [--effort <level>]
  [--session-id <new> | --resume <sid> [--resume-session-at <uuid> --fork-session]]
```

run in Pi's working directory. Claude Code's built-in tools are off and no user,
project or local settings load; the only tools are Pi's, served by the bridge as
MCP server `pi`, which Claude Code namespaces in front of each tool name. Sessions persist, because forks need them.

Environment set for the worker:

- `CLAUDE_CODE_TETHER_LIVE=1` turns on Claude Code's message-threads client
  (beta `message-threads-2026-08-12`). The first request of a process is a
  thread `create` with the full system prompt and tools; later requests are
  `continue` and carry only new messages. Claude Code handles thread expiry,
  fingerprint mismatches and stateless fallback itself.
- `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`: Pi owns compaction.
- `ENABLE_TOOL_SEARCH=false`: every Pi tool is loaded directly.
- `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`, `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`,
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`: a parked tool call waits as long as
  Pi's tool runs and is never moved to the background.
- `MAX_MCP_OUTPUT_TOKENS` raised so Claude Code never truncates or spills Pi's
  tool output to a file.
- `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`: a guard. With a custom system prompt
  Claude Code 2.1.316 already omits its git status snapshot and commit/PR
  instructions; this keeps them out if that changes. Pi's own prompt carries the
  user's git conventions.
- `CLAUDE_CODE_DISABLE_THINKING=1` only for "off" on models that allow it.

Telemetry and other Claude Code defaults are left alone: the requests are
Claude Code's own, and identify as such.

## Turns

A Pi request is normalized the way pi-ai's built-in providers do it (failed and
aborted assistant turns dropped, orphaned tool calls answered with "No result
provided"), and every prefix of it gets a rolling content hash. A fingerprint
covers what a running process cannot change: executable, cwd, model, effort,
thinking switch, output cap, system prompt and tools.

The manager keeps per Pi session one live worker and a map from prefix hash to
the Claude Code transcript entry (session id + uuid) that ends that prefix. It
fills the map from stream-json output: the uuid it assigns to each stdin user
frame, the uuid of each tool_result entry, and the uuid of the last entry of
each assistant message. Each assistant message Pi stores also carries its anchor
as a `claude-sub.anchor` diagnostic, together with the prefix hash it is valid
for, so a later Pi process can adopt it.

For each request:

1. **continue**: same fingerprint, the live worker is idle, and Pi's history is
   exactly what it has seen plus new user messages: one stdin frame.
2. **tool-results**: the live worker is parked on tool calls and the new
   messages are exactly the results for those calls: each parked MCP call is
   answered with Pi's result (text and images, error flag).
3. **fork**: otherwise, find the longest prefix that has an anchor and contains
   every assistant message. Start a worker with `--resume <sid>
   --resume-session-at <uuid> --fork-session` and send the rest (tool results
   and user messages) as one stdin frame. If Claude Code cannot resume the
   session (deleted), the anchors into it are dropped and the request is
   planned again.
4. **synth**: when Pi's history contains assistant messages after the last
   anchor, write a session file: Claude Code's own entries up to the last
   anchor (copied from its session file), then synthesized entries for the
   rest, and `--resume` it. Thinking blocks are kept only for messages this
   provider produced, since signatures are bound to the account.
5. **fresh**: no assistant messages and no anchors: `--session-id <new>`.

A turn ends at the upstream `message_stop` when the stop reason is `tool_use`
(after a short wait for the rate-limit event), or at Claude Code's `result`
otherwise. Claude Code calls MCP tools after streaming the message; the bridge
correlates each call to its `tool_use` id through `_meta.claudecode/toolUseId`,
falling back to order and name. If Claude Code answers a call itself (for
example on invalid input), the worker is marked diverged and the next request
forks.

Aborting a turn sends a stream-json `interrupt` control request, then closes
the worker. The next request forks from the last anchor.

## Usage

Token usage comes from the upstream `message_start` and `message_delta` events.
Anthropic reports the whole conversation's input, cache-read and cache-write
counts even on thread `continue` requests that carry only the new messages, so
Pi's context meter is right.

## Models

`fetchModels` asks Claude Code for its selectable models (`initialize` control
request), then, for each, `set_model` and `get_context_usage` to read the
context window it applies (`rawMaxTokens`). No model request is made. Names,
pricing and output limits come from Pi's built-in Anthropic catalog. Thinking
levels map to `--effort`; levels the model lacks are marked unsupported.

## Limits

- At most four live workers; idle workers close after 15 minutes, parked ones
  after two hours.
- Claude Code sessions created by the extension are registered under Pi's agent
  directory and deleted seven days after their last use.
