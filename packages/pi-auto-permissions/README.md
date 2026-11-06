# pi-auto-permissions

> **Published fork.** This is `@ogulcancelik/pi-auto-permissions` 0.1.3 (MIT, Can Celik)
> plus the dialog-answer evidence feature proposed upstream in
> [ogulcancelik/pi-extensions#24](https://github.com/ogulcancelik/pi-extensions/issues/24) /
> [PR #25](https://github.com/ogulcancelik/pi-extensions/pull/25). Switch back to the
> upstream package once it ships the feature. Never install both packages at once, or
> every Bash call is reviewed twice. Tests live in `test/`: pure module tests plus
> `test/extension.test.ts`, which drives the `tool_call` pipeline through a mock `ExtensionAPI`.

A context-aware permission system for Pi shell commands, with an automated guardian that checks what the user actually authorized.

Pi Auto Permissions pauses configured Bash commands before execution. A guardian model reviews the exact command against a compact view of the current conversation:

- Commands that serve the task and are not on the guardian's block list run automatically, named by the user or not.
- Commands that violate the user's constraints are blocked with feedback so the agent can revise them.
- Block-listed commands the user has not approved (destroying pre-existing data, pushing to default branches, merges, live systems, data leaving the trust boundary, credentials) need the user. By default the command is blocked with the reason and the agent keeps working, asking for approval in its reply; see [Approval modes](#approval-modes).

Only user messages can grant permission or impose constraints. The assistant cannot authorize its own command.

The posture is review-by-default: a fresh install ships a live ruleset (deny rules for oversight bypasses and critical-path destruction, guardian review for force pushes, infrastructure destroys, credential access, and the rest of the default groups), prose trust configuration in `guardianPolicy`, a session-start trust snapshot, an optional blanket `reviewAllShell` mode, a denial ledger with allow-on-retry, and a bundled setup skill that co-authors the trust config with you from observed friction.

## Compared with Claude Code auto mode

The design deliberately mirrors Claude Code's auto mode (default ruleset content, trust tiers, `"$defaults"` splice, session-start remote baseline, denial review) while keeping the pieces pi does better. Honestly stated, both directions:

| | pi-auto-permissions | Claude Code auto mode |
|---|---|---|
| **Verdicts and reasons** | `approve`/`revise`/`ask_user`; always a concrete one-sentence reason; `revise` tells the agent exactly how to clear the objection | Deny only; fixed `Blocked by classifier` text in most sessions |
| **Unapproved actions** | `auto` (default) blocks and keeps the agent working, prompting after 3 blocks in a row or 20 in a session; `careful` prompts at once; `afk` never prompts | Blocks and keeps working; prompts after 3 in a row or 20 total |
| **Evidence caching** | Append-only reviewer lineage: full envelope once, deltas after, fingerprint-invalidated | Stage-1→stage-2 prompt cache; no cross-review evidence cache |
| **Deterministic surface** | Regex gates are testable; the false-positive surface is bounded by the patterns; the guardian runs only after a mechanical match | Prose rules are checkable only by running the classifier |
| **Evaluation loop** | Labelled evaluation JSONL (three-way user labels) + per-review cost sidecar | `/feedback`; no per-review cost or label surface |
| **Coverage** | **Bash only.** Edits, writes, fetches, MCP tools, and subagent spawns are ungated (the beyond-bash plan is the named follow-up) | All tool calls Tier 3-reviewed; in-project edits skip review by design |
| **Sandbox** | None — pair with OS sandboxing for a hard boundary | Integrated sandbox + network-domain review |
| **Injection posture** | Keeps assistant text and tool-call summaries as (non-authorizing) evidence — better provenance, larger injection surface | Strips assistant text and tool output entirely; input-layer injection probe |

## Approval modes

What happens when the guardian cannot approve a command (an `ask_user` verdict, or a review that failed) depends on the session's approval mode:

| Mode | Behavior |
|---|---|
| `auto` (default) | The command is blocked with the guardian's reason. The agent is told not to retry it unchanged, to carry on with the rest of the task, and, if the step is genuinely required, to name the exact command in its final message and ask you. Your reply naming the operation and target ("yes, delete old-experiment") approves it at the next review. A live prompt appears only as a fallback: on the 3rd block in a row without an approval in between, or the 20th in a session. |
| `careful` | You are prompted as soon as the guardian cannot approve a command, and the agent waits for your answer. |
| `afk` | Nothing prompts. Blocked commands are refused, the agent gets a short system prompt section saying you are away, and it lists what it needs approved in its final message. |

Set the default with the **Approval mode** row in `/auto-permissions` or `"approvalMode": "auto" | "careful" | "afk"` in the config, and switch one session with `/auto-permissions auto`, `/auto-permissions careful` or `/auto-permissions afk`. A session switch lasts until the session ends, switches again, or the default changes in the menu, and a new or resumed session starts in the configured default. A blocked command lands in the denial log, so **Recent denials → Allow on retry** clears it too.

To keep the agent working while being careful about specific things, say so in your message ("don't push", "treat vistra as read-only"): the guardian blocks matching actions until a later message lifts the boundary. Boundaries you state live in the transcript, so a compaction can drop them; for anything that must always hold, write it in your own `AGENTS.md` (see [Policy from your instruction files](#policy-from-your-instruction-files)) or use a deny rule.

Subagents keep their own revise-first behavior (see [Subagent sessions](#subagent-sessions)), and an unattended session is always `afk` (see [Unattended sessions](#unattended-sessions)).

## Example

Suppose Git commits are globally guarded.

If the user says:

> Fix the failing test and commit it with a concise lowercase message.

Then a matching commit can run without another permission prompt:

```text
git commit -m "fix retry test"
```

But the guardian rejects a command that violates the request:

```text
git commit -m "Fix the Failing Retry Test and Update Documentation"
```

If the conversation never authorized a commit, an interactive Pi session asks the user before running it. A non-interactive session blocks it.

Permissions are contextual by default. Each command is judged against the current conversation and the exact action being proposed.

## Install

```bash
pi install npm:@hank-warren/pi-auto-permissions
```

For local development:

```bash
pi install /absolute/path/to/pi-extensions/packages/pi-auto-permissions
```

Remove or disable other extensions that gate the same commands to avoid duplicate prompts.

## Define your policy

The extension ships with a default policy, derived from the mechanically matchable rows of Claude Code auto mode's blocked-by-default list. Out of the box — no config file at all — it denies agent-oversight bypasses and critical-path destruction outright, and sends force pushes, history rewrites, infrastructure destroys, piped remote code execution, credential access, registry overrides, PR merges/self-approvals, and shell writes to protected dotfiles to the guardian. A normal dev session (build, test, commit, push a feature branch) triggers zero gates.

The policy is a list of rules. When your config has no `rules` key at all, the built-in ruleset is active. An authored `rules` array fully replaces the built-ins — unless it splices them back in with the literal string `"$defaults"`, which expands to the built-in ruleset at that position so your entries can sit before or after them. An explicit `"rules": []` gates nothing (the pre-0.13 out-of-box behavior, now an explicit opt-out). Commands that do not match a rule run normally.

The default groups — usable in `.pi/trusted-ops` (guarded rules only) — are `oversight`, `destructive`, `git`, `iac`, `net-exec`, `secrets`, `supply-chain`, `review`, and `protected-paths`. See [`default-rules.ts`](default-rules.ts) for the exact patterns and levels.

Configuration is read before every Bash command from:

```text
$PI_CODING_AGENT_DIR/pi-auto-permissions/config.json
```

`PI_CODING_AGENT_DIR` defaults to `~/.pi/agent`.

Here is a policy that keeps the defaults and additionally gates commits, pushes, and publishing:

```json
{
  "rules": [
    "$defaults",
    {
      "pattern": "\\bgit\\s+commit\\b",
      "flags": "i",
      "level": "guarded",
      "group": "git",
      "label": "Git commit"
    },
    {
      "pattern": "\\bgit\\s+push\\b",
      "flags": "i",
      "level": "guarded",
      "group": "git",
      "label": "Git push"
    },
    {
      "pattern": "\\bnpm\\s+publish\\b",
      "flags": "i",
      "level": "guarded",
      "group": "npm",
      "label": "npm publish"
    }
  ]
}
```

Rule fields are:

- `pattern`: JavaScript regular expression source
- `flags`: optional regular expression flags, defaulting to `i`
- `level`: `guarded` for guardian review, or `deny` for a hard block
- `group`: policy group used by trusted-project bypasses
- `label`: short description shown during review
- `message`: optional feedback; required for deny rules

A deny rule is a hard policy boundary: it blocks immediately with its message, is evaluated before every other level, and nothing lifts it — not a trusted group, not user approval at a prompt. Reserve it for operations that should never happen in an agent session (disabling agent oversight, deleting critical paths), and use `guarded` where a human judgment call is legitimate. One exception: rules match raw text, so in a multi-line command a deny pattern can match across lines the shell runs as separate commands. A deny match on a command containing a newline is therefore sent to the guardian under that rule's label instead of blocked outright; it is still reviewed, never passed. Single-line matches stay hard denies.

When several rules match one command, the most severe level wins (deny, then guarded) regardless of their order in the list.

A legacy `"level": "convention"` rule still loads, as a deny rule: it blocks without review, and `.pi/trusted-ops` cannot lift it.

Set `enabled` to `false` to disable the extension. Invalid configuration fails closed and blocks Bash calls until corrected.

### Review every shell command

Set `"reviewAllShell": true` to review every bash command that matches no rule under a generic `shell command` gate (group `all-shell`), the analogue of Claude Code's `classifyAllShell`. The rules then act as a severity layer on top of blanket coverage: deny rules still block outright, and everything else — named by a rule or not — goes to the guardian. The trade is one guardian call per command; pair it with a cheap reviewer model. A command whose matching group is listed in `.pi/trusted-ops` was explicitly waved through and is not re-captured by the blanket gate; trusting `all-shell` itself opts a project out of blanket review while keeping the ruleset live. Lineage caching and the evaluation log apply to `all-shell` reviews unchanged.

## Policy from your instruction files

The guardian reads the same `AGENTS.md` / `CLAUDE.md` files Pi loaded into the agent's prompt: the agent directory's, and those in the working directory and its parents. Pi reports them each turn, so the guardian and the agent never disagree about which files apply. Where a file lives decides what it can do:

| File | Treated as | It can |
|---|---|---|
| Directly in the agent directory (`~/.pi/agent/AGENTS.md`), or outside any git repository and outside the agent directory's installed packages (`~/repos/AGENTS.md`) | **Your policy** | Name what is yours (orgs, hosts, services), make an action routine even if it is block-listed, and require approval for an action. |
| Inside a git repository, or in a package installed under the agent directory | **Project guidance** | Only tighten: its restrictions bind, and it can make an already-allowed step routine. It never clears a block-listed action, because anyone who can change the repository can edit it. |

So write the boundaries you care about where the agent reads them too, for example in `~/repos/AGENTS.md`:

```markdown
## Approvals
- Our GitHub orgs acme-corp and example-labs are our own source control.
- Removing merged worktrees under ~/repos/worktrees is routine cleanup.
- Customer production hosts (*-prod-*.example.internal) need the exact operation and host named before any change.
```

In an untrusted project only the agent directory's files are used. Set `reviewEvidence.projectInstructions` to `false` to turn the files off. They end the reviewer prompt and take part in its fingerprint, so editing one starts a fresh reviewer lineage.

## Define trusted infrastructure

`guardianPolicy` is the reviewer-only alternative to your instruction files: entries the agent never sees, kept in the user-scoped config. The rules decide *which* commands are reviewed; `guardianPolicy` tells the guardian *how to judge them* against your infrastructure. All four lists are prose — write entries the way you would describe your environment to a new engineer:

```json
{
  "guardianPolicy": {
    "environment": [
      "Our GitHub orgs acme-corp and example-labs are trusted source control",
      "registry.internal.example is our internal package registry"
    ],
    "allow": [
      "Uploading build artifacts to the artifacts.example.com bucket is routine"
    ],
    "softDeny": [
      "Do not run database migrations against staging without being asked"
    ],
    "hardDeny": [
      "Never push code or data to a repository outside our GitHub orgs"
    ]
  }
}
```

The lists extend the built-in decision table (which stays active) and are appended to the reviewer prompt as a labeled section with explicit precedence:

1. **hardDeny** blocks unconditionally — user intent, permission overrides, and allow entries never clear it.
2. **softDeny** blocks unless an allow entry covers the action or the user's own message names the exact action and target ("force-push this branch", not "clean up the repo").
3. **allow** entries are exceptions to softDeny and to the trust boundary: data flow only, never destructive or credential operations on the same infrastructure.
4. **environment** entries define what "internal" means — a destination nothing names is treated as a potential exfiltration target.

Each list is independent: setting `environment` alone leaves the others intact. Worth filling in, slot by slot: your source control orgs, trusted internal domains, cloud buckets, package registries and mirrors, key internal services — and on the sensitive side, production namespaces, sensitive data locations, and remote targets that should always get a hard look. These sections are appended outside `systemPrompt`, so a customized `systemPromptFile` still receives them, and every entry participates in the reviewer fingerprint, so editing the policy safely invalidates the cached reviewer lineage.

Alongside your configured entries, the guardian always receives a `SESSION ENVIRONMENT` section captured once at session start: the working directory, repository root, and the `git remote -v` baseline. Those remotes are within the session's trust boundary; a remote added or repointed mid-session is not — which pairs with the default `git remote add|set-url` gate rule, giving the guardian a baseline to judge those commands against. In a non-repository directory the section says exactly that, so no repository trust is assumed.

The precedence tiers are prompt-enforced, like Claude Code's own; the mechanically enforced hard boundary is the `deny` rule level.

### `/auto-permissions setup`

The subcommand is a **pointer**: it hands the job straight to the bundled **`auto-permissions-setup` skill**, starting that conversation on the keystroke. The skill starts with guardian friction logs, prefers session-recall tools over raw session scans, interviews you about ambiguous hosts and absolute boundaries, and applies confirmed edits with a dated backup, diff, and loader validation.

There used to be a second path here — a one-shot wizard that scanned the project and your ten most recent sessions and rendered an accept-or-discard draft. It is gone. A conversation can ask which of two look-alike hosts is production, weigh friction across your whole history rather than a fixed window, and be argued out of a bad suggestion; a fixed draft could do none of that, so the two were never equal and keeping both only split the maintenance. What survives is the property that mattered: `guardianPolicy` is read only from the user-scoped config file — never from a project file — so a checked-in repository cannot inject its own trust entries.

## Guardian configuration

By default, the guardian uses Pi's active model with low reasoning effort and a 30-second timeout. You can select a separate low-cost model.

Giving the guardian its own account keeps reviews from competing with your interactive session for a subscription's rate limits. Pi keys OAuth credentials by provider id, so a second login needs a second provider id — which is what [`@hank-warren/pi-multi-login`](../pi-multi-login/README.md) exists to create. This package no longer registers one itself.

1. `pi install npm:@hank-warren/pi-multi-login`
2. Run `/multi-login` and add a login with base `openai-codex` and suffix `auto-permissions`; then run `/login`, pick the new provider, and complete OAuth with the account reserved for guardian reviews.
3. Select the dedicated provider in the Auto Permissions config:

```json
{
  "reviewer": {
    "provider": "openai-codex-auto-permissions",
    "model": "gpt-5.6-luna",
    "reasoningEffort": "low",
    "timeoutMs": 30000
  }
}
```

The separate credential is stored in Pi's normal `auth.json` under `openai-codex-auto-permissions`; the existing `openai-codex` credential is unchanged. The alias uses Pi's built-in OpenAI Codex OAuth flow, model catalog, and transport. Because it is a normal provider, its models also appear in Pi's model selector and in `/login` after login.

If you already used the login this package registered in earlier versions, nothing changes: `pi-multi-login` adopts the existing `openai-codex-auto-permissions` credential on first run, so the config above keeps resolving. Without that package installed, the provider is missing and Auto Permissions warns once per session; point `reviewer.provider` at `openai-codex` (or any signed-in provider) to silence it.

Other reviewer providers continue to work by setting their normal provider and model ids.

### `/auto-permissions`

The reviewer settings that change most often are editable from a settings menu instead of the config file:

| Row | What it edits |
| --- | --- |
| Enabled | `enabled` — off disables all gating, including deny rules; every command runs unreviewed |
| Approval mode | `approvalMode`, cycling through `auto`, `careful` and `afk` (see [Approval modes](#approval-modes)); the session you change it from drops its own `/auto-permissions <mode>` switch |
| Reviewer model | `reviewer.provider` / `reviewer.model`, picked from the models you are signed in to |
| Thinking level | `reviewer.reasoningEffort` |
| Review timeout | `reviewer.timeoutMs`, entered as `30s` or `45000ms` |
| Parallel reviews | `reviewConcurrency`, cycling through 1, 2, 4, 8 and 16; a hand-written value in between stays in the cycle |
| System prompt | read-only: the resolved path of the active `systemPromptFile`, or whether the built-in or an inline prompt is in use |
| Recent denials | read-only view of the denial log with **Allow on retry**; shown while `denialLog` is enabled (the default) |

Saves are applied immediately — the config is re-read on every guarded command, so there is nothing to restart, in this session or any other. The menu is a narrow writer: it merges only the keys above into whatever is on disk, so rules, prompts, evidence settings and log paths stay exactly as you wrote them and remain file-only. A config that fails validation is never rewritten; the menu reports the error and refuses to open.

### Guardian prompt

The bundled prompt is allow-by-default with a block list, like Claude Code's classifier: an action that serves the user's task is approved unless it is block-listed (destroying data or state the session did not create, rewriting shared history or pushing to default and deploy branches, merging or publishing, live and production systems, data leaving the trust boundary, credentials, executing unreviewed code, or anything the user said not to do). A user message that names the operation and its target, or a short "yes" answering an assistant request that named them, approves a block-listed action. Replace the prompt inline with `systemPrompt`, or load a file:

```json
{
  "systemPromptFile": "./guardian-prompt.md"
}
```

Relative paths resolve from the configuration directory. Set only one of `systemPrompt` or `systemPromptFile`.

The guardian must return one of three decisions:

- `approve`: execute the command
- `revise`: block it and tell the main agent what to correct
- `ask_user`: the user is needed. In `auto` and `afk` the command is blocked with the reason (see [Approval modes](#approval-modes)); in `careful`, or as `auto`'s fallback, it opens an approval prompt (rendered with [`@hank-warren/pi-permission-selector`](../pi-permission-selector)'s `OptionSelector`): the command, then the guardian's note behind a `▌` bar in a fixed strong yellow (gold on dark themes, dark goldenrod on light ones, regardless of the theme's `warning` color), then numbered options. A command taller than a quarter of the terminal is cut to a preview, and the prompt stays pinned while you scroll the session above. Ctrl+O opens the full command in a scrolling viewer inside the prompt (Shift+↑/↓ or the mouse wheel; PgUp/PgDn outside fullscreen) and closes it again — the only complete copy when a codemode script built the command, since the transcript then shows the script. Numbered options with `1`–`9` hotkeys, Tab to attach a note that is delivered to the agent as a steering user message, Esc to cancel — which blocks the command. In RPC mode, as in a pi-agents child whose prompts the parent shows, the prompt is Pi's plain select dialog instead: Allow or Block, without Tab notes. It waits for the RPC client's answer, so a client that never answers holds the command until the turn is cancelled

## Conversation context and caching

The guardian receives a compact chronological view of Pi's active, compaction-aware conversation context plus the exact pending command. It includes retained user and assistant text, Pi's latest compaction summary, small summaries of finalized tool calls, and for each finished shell call a short head-and-tail excerpt of what it printed (about 400 characters, labelled `OUTPUT (untrusted excerpt)`), so the guardian can see facts the command text hides, such as a directory not being a git repository. It excludes summarized-away history, thinking, other tools' output bodies, file contents, patches, images, and session metadata. Compaction summaries and shell output are non-authoritative context and cannot grant permission; older tool records collapse to their status line on a full rebuild, output included.

The extension also recognizes native checkpoints created by [`@ogulcancelik/pi-codex-compaction`](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-compaction). It keeps the checkpoint's retained plaintext user messages and post-checkpoint evidence, while excluding the opaque provider state and older local history. This integration is optional and does not change behavior when `pi-codex-compaction` is not installed.

The first review sends the complete compact evidence. Later reviews reuse the same reviewer session and append only newly finalized evidence and the latest action. The extension uses stable session identity, cache affinity, and long cache retention when supported by the provider. Branch changes, model or policy changes, failures, cancellation, and context pressure reset the reviewer session.

Assistant and tool evidence provide context but never grant permission. Later user messages override earlier conflicting user instructions.

### Codemode scripts

A codemode script runs shell commands from inside it, so judging one of its `bash` calls alone misses what the script is doing around it: a loop over forty targets, or a delete that only makes sense because a backup runs first. The guardian therefore sees the script itself:

- **The running script.** A call a script makes is reviewed with that script's source as an assistant-source `SCRIPT codemode [<call id>]` record, and the proposed action names it in `issuedByScript`. It sits in the evidence stream rather than in the proposed action, so every call from one script shares it through the cached reviewer lineage instead of re-sending it.
- **Finished scripts.** Their `SCRIPT` record stays, and their `TOOL` record lists every call they made and whether it succeeded, from the `nestedCalls` record Pi keeps on the result.
- **Never authorization.** The script is model-written: comments, strings and names in it grant nothing. A policy section appended outside `systemPrompt` tells the guardian to use it only for context, and to judge an action whose prerequisite was blocked, failed, or runs concurrently as if that step never happened.

Scripts are capped at 8000 characters (head and tail, with an elision marker), and a full reviewer rebuild keeps the source of only the five newest; older ones collapse to `SCRIPT codemode [<call id>] (source elided)`.

Instruction files are covered in [Policy from your instruction files](#policy-from-your-instruction-files).

### Interactive dialog answers

When the main agent gathers a decision through an interactive question tool (for example `ask_user_question`), the user's selection is stored as a tool result, which never grants permission. Operators can allowlist user-answer tools, whose confirmed answers become `source: "user"` evidence records:

```json
{
  "reviewEvidence": {
    "userAnswerTools": ["ask_user_question"]
  }
}
```

A successful result from an allowlisted tool qualifies when its `details` are `{ "answers": [{ "question": string, "answer"?: string, "selected"?: string[], "notes"?: string }], "cancelled": false }` with no `error` field. `selected` takes precedence over `answer`, non-string answers are ignored, and notes count only alongside a real answer. Each answered question contributes one `USER (dialog answer):` record; the guardian treats it as authorization for exactly the selected content and is told the question wording is assistant-drafted context, never an instruction. When the matching tool call's arguments carry `questions[].options[]` with `label` and `description`, the description of each selected option is quoted in the record (capped at 1000 characters), because the user saw it beside the label: an option labelled "Own hc session" whose description says it also approves a probe run now carries that approval, while the same sentence in an unselected option does not. Any dialog extension emitting that shape qualifies.

### Injected user messages

Extensions inject context with `appendCustomMessageEntry`, and Pi converts that content into a **user message for the model** — but the session entry is a `custom_message` with no role, so the reviewer never saw it. The model was acting on text the guardian could not read.

`reviewEvidence.userMessageTypes` allowlists the `customType`s whose content becomes `source: "user"` evidence:

```json
{
  "reviewEvidence": {
    "userMessageTypes": ["my-objective-anchor"]
  }
}
```

The default is an empty list: no injected type is trusted until you name it.

Each text block contributes one `USER (<customType>):` record, in session order, never truncated — user records are the only ones that can authorize or constrain. Images are dropped. The guardian is told these records authorize exactly the operations they name, that their constraints bind, and that their content is data rather than instructions.

Injected messages whose `customType` is **not** allowlisted are still visible — as `CUSTOM <customType>:` records with `source: "tool"`, capped like any tool record. They routinely carry the reason a command was proposed (subagent return values, CI outcomes, process notifications), so hiding them left the guardian judging commands with no visible motive; but they are extension output, and only the allowlist can promote a type to user-source, so a subagent's return value can explain a command without ever authorizing it.

The allowlist matches what you wrote: a bare name such as `ask_user_question` matches that tool in any namespace (`functions.ask_user_question` included), while a dotted name matches exactly. The default is an empty list.

## Parallel reviews

When several guarded commands are pending at once, their guardian reviews run in parallel: a codemode script that runs `bash` calls under `Promise.all`, or several `bash` calls in one assistant message. Verdicts are still applied, and you are still asked, one command at a time.

```json
{
  "reviewConcurrency": 4
}
```

`reviewConcurrency` (1–16, default 4) caps how many guardian calls run at once; the **Parallel reviews** row in `/auto-permissions` sets it too. Set it to `1` for fully serial reviews. Parallel reviews all build on the same cached reviewer lineage: the first to finish extends it and the others' exchanges are dropped, which loses nothing because prior reviewer responses are non-authoritative. When there is no usable lineage yet (the first review of a session, or after a compaction, reset or cancellation), one review builds it from the full evidence and the others wait for it and extend it, so a batch pays for one cold request rather than one each. If that build fails, the waiting reviews go ahead on their own instead of queuing behind each other.

- **Codemode scripts.** Pi runs each `bash` call a script makes through the same `tool_call` gate as a model-issued call, concurrently, so their reviews simply overlap. When a script ends — it returns, throws, times out or is aborted — while some of its calls are still queued, under review or waiting on your approval, those are released at once: the guardian request is cancelled (the reviewer lineage is kept) and an open prompt closes by itself. Pi never runs such a call anyway, because it hands it an already-aborted signal, so this only saves you from answering a prompt that can change nothing.
- **Several calls in one message.** Pi runs the `tool_call` handlers for one message's calls one after another, so the handler of the first `bash` call starts the reviews of the later guarded ones. Each call later takes its early review only when the input Pi finally hands the handler is exactly the input that was reviewed; otherwise it is reviewed afresh. An early review whose call never arrives is dropped when the turn ends. With `reviewConcurrency: 1` nothing is reviewed early.
- **Your answers still bind.** Applying a verdict and prompting you share one slot, and a verdict whose evidence changed while it waited — because you answered another command's prompt, or a tool result landed — is reviewed again before it is applied (up to three reviews per command; the third runs holding that slot, so no other prompt can be answered while it runs). A block you give on one command therefore reaches a sibling that was reviewed while your prompt was open.

## Denial log and retry

Every non-approved outcome — a guardian revise, a user block at the prompt, a deny block, a review-infrastructure failure — is appended to a private `denials.jsonl` sidecar next to the config (0600, 16 MB rotation, one previous generation kept):

```json
{"v":1,"ts":"…","sessionId":"…","tool":"bash","gate":{"label":"Force push","group":"git"},"command":"git push --force …","verdict":"block","reason":"…","decisionSource":"user"}
```

On by default; `"denialLog": { "enabled": false }` opts out, and `path` relocates it.

`/auto-permissions` gains a **Recent denials** view over that ledger. Selecting a denial offers **Allow on retry**: an exact-command session override is added through the existing override machinery (it re-injects as user-source evidence on every later review and survives session resume), and an injected message tells the agent it may run that exact command again. No new authorization pathway exists — it is the same override a live approval prompt would have produced.

Every denial also emits a `pi.events` event — `auto-permissions:denied` with `tool`, `command`, `gate`, `group`, `verdict`, `reason`, `decisionSource` — the pi-native equivalent of Claude Code's `PermissionDenied` hook, for other extensions to react to. Like that hook, it cannot reverse a denial.

Permission overrides also persist as custom session entries, so a resumed session keeps the user's earlier allow decisions and standing block constraints instead of forgetting them.

## Prompted-review evaluation log

Auto Permissions can append a private JSONL regression record whenever the guardian asks for confirmation and the user gives explicit feedback:

```json
{
  "evaluationLog": {
    "enabled": true,
    "path": "./review-evals.jsonl"
  }
}
```

The path defaults to `review-evals.jsonl` beside the Auto Permissions config and resolves relative to that config. The file is created with mode `0600` and rotates to `review-evals.jsonl.1` once it passes 64 MiB, keeping one previous generation, so older rows are discarded. Writing is best effort: a failing log never blocks or changes a permission decision.

When logging is enabled, prompted reviews offer the three labeling choices:

- **Allow — asking was unnecessary** executes the command and records `userChoice: "allow_unnecessary"` with `expectedDecision: "approve"`.
- **Block — asking was appropriate** remains the second choice, blocks the command, and records `userChoice: "block"` with `expectedDecision: "ask_user"`. (A block always affirms the prompt: the guardian has no reject verdict — its only non-approve outcomes are asking you or bouncing the command back to the agent as `revise` — so the only true rejection in the system is yours at this prompt.)
- **Allow — asking was appropriate** executes the command and records `userChoice: "allow_appropriate"` with `expectedDecision: "ask_user"`.

When logging is disabled, the prompt retains the normal **Allow** and **Block** choices. Prompts from Pi or other extensions are unchanged.

Each version 2 record contains the collected user request, exact command, compact reviewer evidence, guardian reason, gate and session metadata, raw user choice, and both labels used for evaluation. The guardian's `actualDecision` is `ask_user`. Automatic-review failures are identified separately with `decisionSource: "review_failure"`. Existing version 1 records can remain in the same JSONL file.

Logging is disabled by default. Records can contain sensitive conversation text and shell commands, so keep the file private and out of repositories. Cancelled or interrupted prompts are not labeled or logged.

## Reviewer usage sidecar

Guardian reviews are model calls made outside the Pi agent loop, so they never appear in the session transcript and are invisible to tools that total usage from session files. Auto Permissions therefore appends one content-free record per completed review:

```json
{"v":1,"id":"3f2b…","ts":"2026-08-11T22:41:03.118Z","source":"auto-permissions","label":"guardian","provider":"anthropic","model":"claude-fable-5","usage":{"input":812,"output":96,"cacheRead":18442,"cacheWrite":0,"reasoning":48,"cost":0.0121}}
```

The record carries identity, timing, and counters only. It never contains prompts, commands, reviewer evidence, verdicts, or responses, which is what makes it safe to keep on by default:

```json
{
  "usageLog": {
    "enabled": true,
    "path": "./usage.jsonl"
  }
}
```

The path defaults to `usage.jsonl` beside the Auto Permissions config and resolves relative to it. The file is created with mode `0600` and rotates to `usage.jsonl.1` once it passes 16 MB, keeping one previous generation. Writing is best effort: a failing sidecar never blocks or changes a permission decision.

[`@hank-warren/pi-stats`](../pi-stats) reads `<agent dir>/<extension>/usage.jsonl` sidecars and shows this usage as its own `provider/model (guardian)` row. Set `"enabled": false` to stop recording.

## Review display

The default UI shows guardian progress as a single animated status line in a temporary widget above the editor:

```text
auto permissions · Git commit · ✶ waiting for openai-codex-auto-permissions/gpt-5.6-luna
```

A sparkle spinner (`✶ ✸ ✻ ✽`) cycles while the guardian is reviewing and resolves to `✓ approved`, `↻ revision requested`, or `✗ blocked`. When approval is needed, the widget row steps aside for the approval dialog, whose static yellow `●` heading keeps it visually distinct from the transcript; with several commands under review, the summary line still counts the ones `waiting for your approval`. The reason, when present, appears on a second line behind a `▌` bar in the outcome's color; the command itself is not repeated because it is already visible in the Bash tool box. Configure the widget with:

```json
{
  "ui": {
    "enabled": true,
    "resultDisplayMs": 2500
  }
}
```

While several commands are under review at once, the widget collapses them into one summary line:

```text
auto permissions · 3 commands · ✶ 2 waiting for openai-codex-auto-permissions/gpt-5.6-luna · ⋯ 1 queued
```

`queued` counts commands waiting for a review slot, or with a verdict waiting to be applied behind another command's prompt.

Set `ui.enabled` to `false` to hide review state without disabling enforcement.

### Herdr pane indicator

When the environment variable `HERDR_ENV` is set to exactly `1`, the extension additionally emits a `herdr:blocked` event whenever a command is waiting on your approval, and a matching cleared event once the review resolves. [Herdr](https://herdr.dev), a terminal multiplexer for coding agents, sets this variable for the panes it manages and uses the event to flag the pane that needs attention — useful when a review is blocking in a pane you are not currently looking at. The blocked event carries the gate label so the indicator can name the operation.

This is an optional integration and nothing needs to be configured to use it. Outside Herdr the variable is unset, the emit is skipped entirely, and every other feature behaves identically; the extension has no dependency on Herdr being installed.

### Answering a prompt from another device

Off by default. Set `"remoteAnswers": true` to let another extension relay an open approval prompt elsewhere, such as to your phone, and answer it from there. Nothing changes until you do: with the setting off, no event is sent and every answer is ignored.

With it on:

- **When a prompt opens**, the extension emits `auto-permissions:prompt` on `pi.events`: `{ active: true, id, gate, header, command, noteLabel, note, options, cwd, sessionId, openedAt }`.
- **When it settles**, it emits `{ active: false, id, choice?, remote }`. `choice` is absent when the prompt was cancelled; `remote` says whether the answer came from the event.
- **To answer**, emit `auto-permissions:answer` with `{ id, choice }`. The answer is honoured only while that prompt is still open, and only with one of the `options` it announced. It settles the prompt exactly as the matching keypress would, including the override evidence and the evaluation log.
- **The terminal prompt stays live.** Whichever answer comes first wins, and a later one is ignored.
- **Subagent prompts are not announced.** They are rendered by the parent session (RPC mode), which owns answering them.

The events stay inside the pi process; how a relay reaches another device, and who may answer there, is that extension's job. Only enable this with a relay you trust: any extension that can emit the answer event can approve a prompt.

## Trusted groups

In a trusted project, create `.pi/trusted-ops` to bypass selected rule groups:

```text
git
gh
```

Group names come from your configured rules. A trusted group bypasses guarded review for that group, so use it only in projects you control. Deny rules are never bypassed: `.pi/trusted-ops` is a project-scoped file, and a checked-in file must not be able to disarm a hard policy boundary.

## Agents messaging agents (hc)

In a [herdr-core](https://herdr.dev/core/) terminal (`HC_TERMINAL_ID` set), another agent's message arrives as a user message wrapped in `<hc from="t7 …">`. At session start the extension asks `hc get` which terminal started this one, and every bash call waits for that lookup:

- A message from the **parent** terminal is a relayed user record, `USER (relayed by parent agent t7)`. It authorizes exactly the operations and targets it names, because the parent's own guardian reviewed the `hc send` that delivered it against the parent's user messages: telling a child to push `main` needs the same approval in the parent as pushing it there.
- A message from **any other** terminal (a helper reporting back, a sibling) or from hc itself is `AGENT MESSAGE` context with `source: "tool"`. It never authorizes anything, even when it says the user approved something.
- If the parent cannot be found, nothing relayed authorizes.
- Messages retained across a native compaction are classified the same way.

The labels depend on hc's tag, and hc tags a message only when it is sent from an agent's terminal. Text sent from a plain shell or program terminal (for example `hc run -- hc send t7 "…"`) arrives untagged and is indistinguishable from typed input, so it reads as the user's own message. The control that holds either way is the sending agent's guardian reviewing the hand-off.

Every `hc send`, `hc run`, `hc keys` and `hc interrupt` is reviewed by a default rule, even without `reviewAllShell`, because a child's trust in its parent's messages rests on that review. The rule matches loosely and the guardian decides the rest, with this session's own terminal id in each request: it judges a delegation as if the agent would do what the message asks, asks for the message inline when the command reads it from a file or variable, holds a relayed message to exactly what it names (no standing approval), and asks the user when a command sends input to the agent's own terminal, however wrapped, or types into a terminal blocked on a prompt.

The relay assumes the parent's bash calls go through its own guardian. A parent running another harness, with approvals off, or trusting the `oversight` group reviews nothing, and its child cannot tell.

## Subagent sessions

When a session is a subagent child (`PI_SUBAGENT_CHILD=1`, set by `@hank-warren/pi-agents` and [pi-subagents](https://github.com/nicobailon/pi-subagents)), the guardian receives additional execution facts with each review — run id, nesting depth, whether the cwd is a linked git worktree, and the checked-out branch — plus a prompt section telling it to judge risk by effect scope and reversibility relative to the subagent's own workspace instead of by command name. Mutations confined to the subagent's isolated worktree, its own feature branch, or resources it created are approvable when they serve the delegated task; `ask_user` is reserved for effects that escape that scope (shared or default branches, host-level configuration, production systems, credentials, data leaving the machine).

The child itself is told it is a subagent: a short section appended to its system prompt says that commands needing approval pause the supervising session, so it should prefer in-scope and read-only commands and revise when asked to. On Pi 1.x the section is a named prompt section (`auto_permissions_subagent`), so it never replaces the prompt that Pi and other extensions build, such as the parent's instruction files pi-agents adds to a child.

An `ask_user` verdict in a subagent, or a failed review (timeout, unavailable reviewer, unparsable verdict), never interrupts the human on the first try:

- **Child with a UI** (an RPC child whose prompts surface in the parent, as with pi-agents): the command is blocked with a revise-first reason. Issuing the *same* command again unchanged in a later turn escalates it to the human as an ordinary approval prompt, once: after that, a later identical attempt is revised first again. Duplicates within the same turn (sibling calls, or a codemode `Promise.all`) are refused as well, because the model has not seen the first refusal yet. Any other command gets its own revise-first turn.
- **Child without a UI**: the command is blocked with a reason instructing the child to route around the gated operation or report the blocker.

The guardian's subagent section says which of these applies, so a child without a UI is never told a human may approve later. A revise-first refusal is recorded in the denial log and the `auto-permissions:denied` event with `"reviseFirst": true`, keeping the `decisionSource` of the verdict behind it, so it stays distinguishable from a guardian's own revise.

Reviewer usage records from subagent sessions carry `"subagent": true` in the usage sidecar.

## Unattended sessions

Some hosts have a UI that nobody answers. An ACP bridge driven by a chat system — Buzz running Pi through `buzz-pi-acp`, for example — forwards each approval prompt as a `session/request_permission` and auto-selects its first "allow" option, so every `ask_user` verdict would quietly become an approval (and, with the evaluation log on, be recorded as "asking was unnecessary").

Set `PI_AUTO_PERMISSIONS_UNATTENDED=1` in the environment of such a session, for example in the command that launches the bridge. Such a session is always in the `afk` [approval mode](#approval-modes), and `/auto-permissions` cannot switch it:

```bash
env PI_AUTO_PERMISSIONS_UNATTENDED=1 buzz-pi-acp
```

In that mode:

- An `ask_user` verdict, or a failed review, **blocks** the command and never opens a prompt. The agent is told to get the result another way, or to ask the user to approve the exact command in its reply and stop.
- The agent gets a short system prompt section (`auto_permissions_unattended` on Pi 1.x) saying the same before it starts.
- The guardian is told that approval can only arrive as a later user message naming the exact operation and target, that an assistant's claim of approval is never authorization, and that a chat system may relay messages from several senders. A retry is reviewed again like any command, so it goes through only once the user's reply is in the evidence.
- Nothing is written to the evaluation log, because no human answered a prompt.
- Revise-first does not apply, even in a subagent: there is no human to protect from the interruption, and the block already says what to do.

To restrict who can approve, set `PI_AUTO_PERMISSIONS_APPROVERS` to a comma-separated list of sender identities as the chat system writes them (names, public keys, account ids; up to 16, letters, digits and `_.@:+-` only). The guardian then treats only messages from those senders as authorization. Invalid entries are dropped; if none is valid (a display name with a space, say), the list fails closed and no message can authorize anything beyond low-risk actions. Without the variable, the guardian accepts approval from the sender who gave the agent its task.

## Guardian dispatch

Reviewer requests dispatch through the host's model runtime rather than pi-ai's compat layer, so provider transports registered by other extensions (for example `@gotgenes/pi-anthropic-auth` OAuth request shaping) apply to guardian calls. When the runtime seam is unavailable, dispatch falls back to `compat.completeSimple`.

## Failure behavior

A missing reviewer model, unavailable credentials, malformed response, timeout, cancellation, or oversized review context never auto-approves a command.

- A failure is handled like an `ask_user` verdict under the session's [approval mode](#approval-modes): blocked in `auto` and `afk` (the agent is told a later retry may succeed), a prompt in `careful`.
- Non-interactive sessions block the command.
- Invalid configuration blocks Bash calls until corrected.

## Security boundary

Rules match raw shell text. Quoting, variables, aliases, generated scripts, or other indirection can evade a regex, while quoted command text can cause false positives.

Pi Auto Permissions is a permission layer for normal agent behavior. It is not an operating-system sandbox or a defense against hostile shell input. Pair it with sandboxing when commands need a hard security boundary.

`reviewEvidence.userAnswerTools` widens what counts as user authorization: any code that can record a tool result under an allowlisted tool name can mint `USER (dialog answer)` evidence. Allowlist only tool names served by extensions you trust.

`reviewEvidence.userMessageTypes` widens it the same way, and is why it is an allowlist rather than "project every injected message": any installed extension can append a custom message under any `customType`, so a blanket rule would let any of them mint user authorization. Allowlist only types written by extensions you trust.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
