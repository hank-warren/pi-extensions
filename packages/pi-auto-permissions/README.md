# pi-auto-permissions

> **Published fork.** This is `@ogulcancelik/pi-auto-permissions` 0.1.3 (MIT, Can Celik)
> plus the dialog-answer evidence feature proposed upstream in
> [ogulcancelik/pi-extensions#24](https://github.com/ogulcancelik/pi-extensions/issues/24) /
> [PR #25](https://github.com/ogulcancelik/pi-extensions/pull/25). Switch back to the
> upstream package once it ships the feature. Never install both packages at once, or
> every Bash call is reviewed twice. The upstream `index.test.ts` harness suite is not
> vendored; the pure config/evidence tests live in `test/`.

A context-aware permission system for Pi shell commands, with an automated guardian that checks what the user actually authorized.

Pi Auto Permissions pauses configured Bash commands before execution. A guardian model reviews the exact command against a compact view of the current conversation:

- Clearly authorized and compliant commands run automatically.
- Authorized commands that violate the user's constraints are blocked with feedback so the agent can revise them.
- Commands without clear authorization are sent to the user for confirmation.
- High-risk commands always require confirmation.

Only user messages can grant permission or impose constraints. The assistant cannot authorize its own command.

The posture is review-by-default: a fresh install ships a live ruleset (deny rules for oversight bypasses and critical-path destruction, guardian review for force pushes, infrastructure destroys, credential access, and the rest of the default groups), prose trust configuration in `guardianPolicy`, a session-start trust snapshot, an optional blanket `reviewAllShell` mode with a cheap prefilter stage, a denial ledger with allow-on-retry, and a bundled setup skill that co-authors the trust config with you from observed friction.

## Compared with Claude Code auto mode

The design deliberately mirrors Claude Code's auto mode (default ruleset content, trust tiers, `"$defaults"` splice, session-start remote baseline, two-stage review, denial review) while keeping the pieces pi does better. Honestly stated, both directions:

| | pi-auto-permissions | Claude Code auto mode |
|---|---|---|
| **Loop/retry budgets** | Three orthogonal budgets (per-concern, per-gate, streak); the streak resets only when an approval lands on a gate that was actually blocking; persisted across compaction and resume | 3-consecutive/20-total; *any* allowed action resets the consecutive counter, so interleaved reads defeat it; not configurable |
| **Verdicts and reasons** | `approve`/`revise`/`ask_user`; always a concrete one-sentence reason; `revise` tells the agent exactly how to clear the objection | Deny only; fixed `Blocked by classifier` text in most sessions |
| **Evidence caching** | Append-only reviewer lineage: full envelope once, deltas after, fingerprint-invalidated | Stage-1→stage-2 prompt cache; no cross-review evidence cache |
| **Deterministic surface** | Regex gates are testable; the false-positive surface is bounded by the patterns; the guardian runs only after a mechanical match | Prose rules are checkable only by running the classifier |
| **Evaluation loop** | Labelled evaluation JSONL (three-way user labels, prefilter FNR records) + per-review cost sidecar | `/feedback`; no per-review cost or label surface |
| **Coverage** | **Bash only.** Edits, writes, fetches, MCP tools, and subagent spawns are ungated (the beyond-bash plan is the named follow-up) | All tool calls Tier 3-reviewed; in-project edits skip review by design |
| **Sandbox** | None — pair with OS sandboxing for a hard boundary | Integrated sandbox + network-domain review |
| **Injection posture** | Keeps assistant text and tool-call summaries as (non-authorizing) evidence — better provenance, larger injection surface | Strips assistant text and tool output entirely; input-layer injection probe |

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

Permissions are contextual by default. Each command is judged against the current conversation and the exact action being proposed; the user may explicitly promote one guardian-approved prompt decision into a revocable standing approval for comparable commands.

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
- `level`: `guarded` for guardian review, `convention` for an overridable policy block, or `deny` for a hard block
- `group`: policy group used by trusted-project bypasses
- `label`: short description shown during review
- `message`: optional feedback; required for convention and deny rules

A convention rule blocks directly with its configured feedback instead of asking the guardian. The agent can call `request_override` for a legitimate one-session exception. Overrides require user confirmation and cannot bypass guarded rules.

A deny rule is a hard policy boundary: it blocks immediately with its message, is evaluated before every other level, and nothing lifts it — not `request_override`, not a trusted group, not user approval at a prompt. Reserve it for operations that should never happen in an agent session (disabling agent oversight, deleting critical paths), and use `guarded` where a human judgment call is legitimate.

When several rules match one command, the most severe level wins (deny, then convention, then guarded) regardless of their order in the list.

Set `enabled` to `false` to disable the extension. Invalid configuration fails closed and blocks Bash calls until corrected.

### Review every shell command

Set `"reviewAllShell": true` to review every bash command that matches no rule under a generic `shell command` gate (group `all-shell`), the analogue of Claude Code's `classifyAllShell`. The rules then act as a severity layer on top of blanket coverage: deny rules still block outright, convention rules still block with feedback, and everything else — named by a rule or not — goes to the guardian. The trade is one guardian call per command; pair it with a cheap reviewer model. A command whose matching group is listed in `.pi/trusted-ops` was explicitly waved through and is not re-captured by the blanket gate; trusting `all-shell` itself opts a project out of blanket review while keeping the ruleset live. Loop budgets, lineage caching, and the evaluation log apply to `all-shell` reviews unchanged.

## Define trusted infrastructure

The rules decide *which* commands are reviewed; `guardianPolicy` tells the guardian *how to judge them* against your infrastructure. All four lists are prose — write entries the way you would describe your environment to a new engineer:

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

### Two-stage review

Set `"prefilter": true` inside the `reviewer` block for the Claude Code stage-1/stage-2 structure: before the full lineage review, a stateless single-token pass at minimal reasoning answers `SAFE` or `REVIEW` over the same envelope text. `SAFE` approves immediately (the review row shows reason `prefilter`); `REVIEW` — and any parse or infrastructure failure — falls through to the full review unchanged, so the prefilter can only ever short-circuit toward *more* review, never approve by accident. Because the prefilter envelope matches a full-rebuild review's, the escalated call is largely a provider prompt-cache hit of the prefilter call. The lineage conversation is untouched.

Prefilter calls are recorded in the usage sidecar under a distinct `prefilter` label, and — when the evaluation log is enabled — every prefilter approval is logged with `"decisionSource": "prefilter"` so its false-negative rate can be measured offline against the same labels as prompted reviews. Off by default until that data justifies flipping it; it pays off most with `reviewAllShell`, where the per-command cost matters.

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
| Enabled | `enabled` — off lets every command run without guardian review |
| Reviewer model | `reviewer.provider` / `reviewer.model`, picked from the models you are signed in to |
| Thinking level | `reviewer.reasoningEffort` |
| Review timeout | `reviewer.timeoutMs`, entered as `30s` or `45000ms` |
| System prompt | read-only: the resolved path of the active `systemPromptFile`, or whether the built-in or an inline prompt is in use |
| Standing approvals | count plus a picker for revoking user-scoped comparable-command approvals |

Saves are applied immediately — the config is re-read on every guarded command, so there is nothing to restart, in this session or any other. The menu is a narrow writer: it merges only the keys above into whatever is on disk, so rules, prompts, evidence settings and log paths stay exactly as you wrote them and remain file-only. A config that fails validation is never rewritten; the menu reports the error and refuses to open.

### Guardian prompt

The bundled prompt evaluates authorization, command risk, and compliance with user constraints. Replace it inline with `systemPrompt`, or load a file:

```json
{
  "systemPromptFile": "./guardian-prompt.md"
}
```

Relative paths resolve from the configuration directory. Set only one of `systemPrompt` or `systemPromptFile`.

The guardian must return one of three decisions:

- `approve`: execute the command
- `revise`: block it and tell the main agent what to correct
- `ask_user`: open an approval prompt (rendered with [`@hank-warren/pi-permission-selector`](../pi-permission-selector)'s `OptionSelector`): numbered options with `1`–`9` hotkeys, Tab to attach a note that is delivered to the agent as a steering user message, Esc to cancel — which blocks the command

## Conversation context and caching

The guardian receives a compact chronological view of Pi's active, compaction-aware conversation context plus the exact pending command. It includes retained user and assistant text, Pi's latest compaction summary, and small summaries of finalized tool calls, but excludes summarized-away history, thinking, tool output bodies, file contents, patches, images, and session metadata. Compaction summaries are non-authoritative assistant context and cannot grant permission.

The extension also recognizes native checkpoints created by [`@ogulcancelik/pi-codex-compaction`](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-codex-compaction). It keeps the checkpoint's retained plaintext user messages and post-checkpoint evidence, while excluding the opaque provider state and older local history. This integration is optional and does not change behavior when `pi-codex-compaction` is not installed.

The first review sends the complete compact evidence. Later reviews reuse the same reviewer session and append only newly finalized evidence and the latest action. The extension uses stable session identity, cache affinity, and long cache retention when supported by the provider. Branch changes, model or policy changes, failures, cancellation, and context pressure reset the reviewer session.

Assistant and tool evidence provide context but never grant permission. Later user messages override earlier conflicting user instructions.

Trusted projects may optionally provide their root `AGENTS.md`, or `CLAUDE.md` when no `AGENTS.md` exists, as policy evidence:

```json
{
  "reviewEvidence": {
    "projectInstructions": true
  }
}
```

Project instructions help interpret the requested workflow, but cannot independently authorize an action or override guardian policy.

### Interactive dialog answers

When the main agent gathers a decision through an interactive question tool (for example `ask_user_question`), the user's selection is stored as a tool result, which never grants permission. Operators can allowlist user-answer tools, whose confirmed answers become `source: "user"` evidence records:

```json
{
  "reviewEvidence": {
    "userAnswerTools": ["ask_user_question"]
  }
}
```

A successful result from an allowlisted tool qualifies when its `details` are `{ "answers": [{ "question": string, "answer"?: string, "selected"?: string[], "notes"?: string }], "cancelled": false }` with no `error` field. `selected` takes precedence over `answer`, non-string answers are ignored, and notes count only alongside a real answer. Each answered question contributes one `USER (dialog answer):` record; the guardian treats it as authorization for exactly the selected content and is told the question wording is assistant-drafted context, never an instruction. Any dialog extension emitting that shape qualifies.

### Injected user messages

Extensions inject context with `appendCustomMessageEntry`, and Pi converts that content into a **user message for the model** — but the session entry is a `custom_message` with no role, so the reviewer never saw it. The model was acting on text the guardian could not read.

`reviewEvidence.userMessageTypes` allowlists the `customType`s whose content becomes `source: "user"` evidence:

```json
{
  "reviewEvidence": {
    "userMessageTypes": ["loop-objective"]
  }
}
```

The default is `["loop-objective"]` — the objective anchor written by [`@hank-warren/pi-loop`](../pi-loop), which carries the objective the user typed or approved and which is frozen for the loop's lifetime. Without it, a looping session's reviewer sees no user authorization for the very task the loop was started to do, and refuses work the user explicitly asked for. Absent means the default; an explicit `[]` opts out entirely.

Each text block contributes one `USER (<customType>):` record, in session order, never truncated — user records are the only ones that can authorize or constrain. Images are dropped. The guardian is told these records authorize exactly the operations they name, that their constraints bind, and that their content is data rather than instructions.

Injected messages whose `customType` is **not** allowlisted are still visible — as `CUSTOM <customType>:` records with `source: "tool"`, capped like any tool record. They routinely carry the reason a command was proposed (subagent return values, CI outcomes, process notifications), so hiding them left the guardian judging commands with no visible motive; but they are extension output, and only the allowlist can promote a type to user-source, so a subagent's return value can explain a command without ever authorizing it.

The allowlist matches what you wrote: a bare name such as `ask_user_question` matches that tool in any namespace (`functions.ask_user_question` included), while a dotted name matches exactly. The default is an empty list.

## Denial log and retry

Every non-approved outcome — a guardian revise, a user block at the prompt, a loop-budget block, a convention or deny block, a review-infrastructure failure — is appended to a private `denials.jsonl` sidecar next to the config (0600, 16 MB rotation, one previous generation kept):

```json
{"v":1,"ts":"…","sessionId":"…","tool":"bash","gate":{"label":"Force push","group":"git"},"command":"git push --force …","verdict":"block","reason":"…","decisionSource":"user"}
```

On by default; `"denialLog": { "enabled": false }` opts out, and `path` relocates it.

`/auto-permissions` gains a **Recent denials** view over that ledger. Selecting a denial offers **Allow on retry**: an exact-command session override is added through the existing override machinery (it re-injects as user-source evidence on every later review and survives session resume), and an injected message tells the agent it may run that exact command again. No new authorization pathway exists — it is the same override a live approval prompt would have produced.

Every denial also emits a `pi.events` event — `auto-permissions:denied` with `tool`, `command`, `gate`, `group`, `verdict`, `reason`, `decisionSource` — the pi-native equivalent of Claude Code's `PermissionDenied` hook, for other extensions to react to. Like that hook, it cannot reverse a denial.

Permission overrides now also persist as custom session entries (the way the loop revise budget does), so a resumed session keeps the user's earlier allow decisions and standing block constraints instead of forgetting them.

## Standing approvals

A prompt caused by a guardian `ask_user` verdict includes **Allow and stop asking about comparable commands**. Choosing it executes the current command and appends a user-scoped record to `standing-approvals.jsonl` beside the config:

```json
{"v":1,"ts":"…","gate":{"label":"…","group":"…"},"command":"…","scope":"comparable","project":"…","reason":"…"}
```

At the next session start, these records become `USER (standing permission override, granted … in …):` evidence for the guardian. The guardian still reviews every mechanically guarded command: a comparable action may approve silently, while an action of a materially higher risk class remains uncovered and can still prompt. The origin project is context, not a scope limit, and later user statements or blocks take precedence.

The ledger is mode `0600`, keeps the newest 200 valid records, and reports once when adding a record evicts the oldest. It is on by default; relocate or disable it with:

```json
{
  "standingApprovals": {
    "enabled": true,
    "path": "./standing-approvals.jsonl"
  }
}
```

Use `/auto-permissions` → **Standing approvals** to select and revoke a record. Revocation takes effect immediately in that session; other already-running sessions drop it at their next session start. Review-infrastructure-failure prompts never offer standing trust, cancelled prompts write nothing, and deny rules never reach a prompt at all.

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

The path defaults to `review-evals.jsonl` beside the Auto Permissions config and resolves relative to that config. The file is created with mode `0600`.

When logging is enabled, prompted reviews offer the three labeling choices plus the standing option on guardian-sourced prompts:

- **Allow — asking was unnecessary** executes the command and records `userChoice: "allow_unnecessary"` with `expectedDecision: "approve"`.
- **Block — asking was appropriate** remains the second choice, blocks the command, and records `userChoice: "block"` with `expectedDecision: "ask_user"`. (A block always affirms the prompt: the guardian has no reject verdict — its only non-approve outcomes are asking you or bouncing the command back to the agent as `revise` — so the only true rejection in the system is yours at this prompt.)
- **Allow — asking was appropriate** executes the command and records `userChoice: "allow_appropriate"` with `expectedDecision: "ask_user"`.
- **Allow and stop asking about comparable commands** executes the command, writes the standing ledger, and records the evaluation label as `userChoice: "allow_unnecessary"`. This fourth choice appears only when the prompt came from a guardian verdict, never when review infrastructure failed.

When logging is disabled, the prompt retains the normal **Allow** and **Block** choices, and **Allow and stop asking about comparable commands** still appears on guardian-sourced prompts when standing approvals are enabled — the standing ledger does not depend on evaluation logging. Prompts from Pi or other extensions are unchanged.

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

A sparkle spinner (`✶ ✸ ✻ ✽`) cycles while the guardian is reviewing and resolves to `✓ approved`, `↻ revision requested`, `? waiting for your approval`, or `✗ blocked`. When approval is needed, the selector's leading `●` pulses between warning-bright and dim so the active prompt remains visually distinct from the transcript. The guardian's reason, when present, appears on a dim second line; the command itself is not repeated because it is already visible in the Bash tool box. Configure the widget with:

```json
{
  "ui": {
    "enabled": true,
    "resultDisplayMs": 2500,
    "placement": "widget"
  }
}
```

Set `placement` to `toolRow` to show the review inside Pi's Bash tool row:

```text
$ git commit --dry-run -m "fix auth"
  ◌ guardian running · Git commit · openai-codex-auto-permissions/gpt-5.6-luna
```

`toolRow` reconstructs Pi's standard local Bash definition because Pi does not expose renderer-only decoration. Do not use it with SDK-provided, remote, sandboxed, or otherwise replaced Bash backends. The extension detects non-native Bash tools and falls back to the widget instead of replacing them.

Set `ui.enabled` to `false` to hide review state without disabling enforcement.

### Herdr pane indicator

When the environment variable `HERDR_ENV` is set to exactly `1`, the extension additionally emits a `herdr:blocked` event whenever a command is waiting on your approval, and a matching cleared event once the review resolves. [Herdr](https://herdr.dev), a terminal multiplexer for coding agents, sets this variable for the panes it manages and uses the event to flag the pane that needs attention — useful when a review is blocking in a pane you are not currently looking at. The blocked event carries the gate label so the indicator can name the operation.

This is an optional integration and nothing needs to be configured to use it. Outside Herdr the variable is unset, the emit is skipped entirely, and every other feature behaves identically; the extension has no dependency on Herdr being installed.

## Trusted groups

In a trusted project, create `.pi/trusted-ops` to bypass selected rule groups:

```text
git
gh
```

Group names come from your configured rules. A trusted group bypasses guarded review and convention blocks for that group, so use it only in projects you control. Deny rules are never bypassed: `.pi/trusted-ops` is a project-scoped file, and a checked-in file must not be able to disarm a hard policy boundary.

## Subagent sessions

When a session is a [pi-subagents](https://github.com/nicobailon/pi-subagents) child (`PI_SUBAGENT_CHILD=1`), the guardian receives additional execution facts with each review — run id, nesting depth, whether the cwd is a linked git worktree, and the checked-out branch — plus a prompt section telling it to judge risk by effect scope and reversibility relative to the subagent's own workspace instead of by command name. Mutations confined to the subagent's isolated worktree, its own feature branch, or resources it created are approvable when they serve the delegated task; `ask_user` is reserved for effects that escape that scope (shared or default branches, host-level configuration, production systems, credentials, data leaving the machine).

Subagent sessions have no interactive user, so an `ask_user` verdict blocks the command immediately with a reason instructing the child to route around the gated operation or report the blocker. Reviewer usage records from subagent sessions carry `"subagent": true` in the usage sidecar.

## Unattended loop sessions

When the session is running an unattended loop, the guardian's decisions are unchanged and only their *delivery* changes: an `ask_user` verdict returns the concern to the agent as a block instead of opening a prompt. This is not a relaxation. A session waiting on a modal is busy, and a busy session starves the loop's own continuation path — no turn completes, no cap trips, and nothing ends the loop until it expires, potentially days later. The prompt would not be answered; it would simply deadlock.

Detection is an environment contract, not a dependency. [pi-loop](https://github.com/hank-warren/pi-extensions/tree/main/packages/pi-loop) sets `PI_LOOP_ACTIVE=1` and `PI_LOOP_ID=<id>` on the process while a loop is active and removes them when it is not; this extension reads them exactly as it reads `PI_SUBAGENT_CHILD`. Neither package imports or depends on the other, and with the variables absent — pi-loop not installed, or no loop running — behavior is identical to today.

The agent is given a bounded number of revision rounds against the guardian's stated concern, after which the block stops offering that option and instructs it to call `loop_wait` (pi-loop's non-deadlocking way to reach a human). The bound is what keeps "address the objection" from becoming "retry until something is approved":

- **3 blocked attempts per concern**, so there are two real revisions: enough for a misread of a terse objection plus a considered fix.
- **5 blocked attempts per gate.**
- **5 consecutive blocked attempts**, at any gate, for any concern — the backstop. An approved command resets it, since an agent getting real work past the guardian is not grinding against it.

The block reports whichever bound is closest, and the stated remainder falls every time. Both of the first two bounds are keyed on something the *command* determines, and a canary walked through each in turn. The guardian rewords its objection between rounds, so a count keyed on that prose stops advancing and the block repeats "1 revision round remains" forever — the agent read two identical blocks, called the number ambiguous, and stopped trusting it. Then, blocked on `git branch -D`, it tried `git branch --delete`: the same operation under a different rule, which reset both the gate counter and the concern key embedded in it. The consecutive-block count is immune to both, because it measures the argument rather than the command, and a concern or gate first seen mid-argument inherits the argument's length instead of starting over.

Counts are held in memory *and* persisted as a session entry, so neither a context compaction nor a session resume hands back a fresh budget. A review that fails for infrastructure reasons blocks without charging a round, since that is not a guardian judgment.

## Guardian dispatch

Reviewer requests dispatch through the host's model runtime rather than pi-ai's compat layer, so provider transports registered by other extensions (for example `@gotgenes/pi-anthropic-auth` OAuth request shaping) apply to guardian calls. When the runtime seam is unavailable, dispatch falls back to `compat.completeSimple`.

## Failure behavior

A missing reviewer model, unavailable credentials, malformed response, timeout, cancellation, or oversized review context never auto-approves a command.

- Interactive sessions fall back to user confirmation.
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
