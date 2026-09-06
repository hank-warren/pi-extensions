# 🧭 pi-plan-mode — Plan mode for Pi

[![npm](https://img.shields.io/npm/v/@hank-warren/pi-plan-mode)](https://www.npmjs.com/package/@hank-warren/pi-plan-mode) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@hank-warren/pi-plan-mode` adds a `/plan` mode to Pi for research and design. You gather information, ask questions, and land on a plan — then implement it, either in the same conversation or in a fresh one.

**Plan mode is a mode of intent, not a permission system.** It blocks `edit` and `write` while planning and leaves every other tool exactly as you configured it. Command safety stays with your permission extension (for example [`@hank-warren/pi-auto-permissions`](../pi-auto-permissions)), which already reviews Bash. The only tool Plan mode ever removes from the active set is its own `plan_mode_question`, and only when a better questionnaire is installed (see below), so it cannot break other extensions.

The plan is written to a **durable file** that survives compaction, survives resume, and can be hand-edited.

## ✨ Features

- `/plan` mode with a planning system prompt: explore first, ask decision questions, do not implement.
- `plan_mode_question` for structured 1-3 question decision points with options and a free-form path — or `ask_user_question` when that is installed (see below).
- `plan_mode_complete({ plan })` writes the plan to `<agent dir>/plans/<session-id>.md`.
- **Pointer, not payload.** An active plan adds one line to the system prompt naming the file. The plan body is never injected into context, so a 50-page plan costs the same as a one-liner and survives compaction for free.
- Two ways to implement: continue in this conversation, or open a fresh session that reads the same file.
- `/plan export [path]` copies the plan anywhere, never overwriting an existing target.
- Hand-edit the plan file at any time; every command and both implementation paths read from disk.
- A shipped **plan-craft doc** the prompt points at by path, carrying the plan-crafting craft the prompt itself only names.

## 📦 Install

```bash
pi install npm:@hank-warren/pi-plan-mode
```

Try without installing permanently:

```bash
pi -e npm:@hank-warren/pi-plan-mode
```

## 🚀 Usage

```text
/plan                 open the menu for the current state
/plan start           enter Plan mode without sending a prompt
/plan <prompt>        enter Plan mode and start planning <prompt>
/plan show            display the stored plan
/plan finalize        ask the agent to complete the plan now
/plan implement       implement the completed plan here
/plan export [path]   copy the plan to a Markdown file
/plan exit            leave Plan mode and delete the plan file
```

`--plan` starts a session directly in Plan mode.

While Plan mode is active, ask the agent to design the change. It can read, search, and run commands, but `edit` and `write` are blocked. When the plan is decision-complete, the agent calls `plan_mode_complete` and the plan is written to disk.

A completed plan is not final until you act on it: just type feedback to revise — the next planning turn supersedes the proposed plan, and the next `plan_mode_complete` replaces it.

From a completed plan you can:

- **Implement here** — Plan mode turns off and implementation continues in this conversation.
- **Start fresh and implement** — a new linked session opens, pointed at the same plan file, without carrying the planning conversation.
- **Export plan…** — write the plan to a path of your choice.
- **Stay in Plan mode** — keep refining. The next planning turn supersedes the previous plan.

Print and JSON modes cannot show the interactive menu; use `/plan start`, `/plan <prompt>`, `/plan show`, `/plan export`, and `/plan exit` there.

## 📄 The plan file

The plan lives at `<agent dir>/plans/<session-id>.md` — normally `~/.pi/agent/plans/<session-id>.md`.

- **It is the plan.** Session state stores only the path.
- **Hand-edit it freely.** Everything reads from disk, so your edits are what the agent implements.
- **It survives compaction** because the model only ever sees a one-line pointer to it, and re-reads the file when needed.
- **A fresh implementation session points at the same file.** The plan is never copied, so both sessions see the same content.
- `/plan exit` deletes it. Export first if you want to keep a copy.

Writes are atomic (temp file plus rename), so a reader never sees a partial plan.

## ⚙️ Settings

Open **Settings** from the `/plan` menu, or edit `$PI_CODING_AGENT_DIR/pi-plan-mode.json` (normally `~/.pi/agent/pi-plan-mode.json`). The file is optional.

The file is read at session start and **re-read whenever it changes**, so a hand-edit — or a save from another session — applies without restarting. Like the plan file itself, it is edited on disk and read from disk.

```json
{
  "defaultPlanExportPath": "PLAN.md"
}
```

### Export destination

`defaultPlanExportPath` controls only exports that omit a path, and defaults to `PLAN.md`. Relative values resolve against the current working directory at export time. An explicit `/plan export <path>` always wins. Export never overwrites an existing file, directory, or symbolic link.

Unknown keys are preserved. Settings removed in 1.0 (`defaultPlanTools`, `bashPolicy`, `safeSubcommands`, `implementationPlanRetention`) and in 1.3 (`thinkingLevel`) are ignored rather than treated as errors, so an existing settings file keeps working.

Thinking level and model are **session** settings, and Plan mode never changes either one. Set them with Pi's own controls; whatever you choose while planning carries into implementation, because that is what session state does.

A settings file that does not parse is reported at session start and the defaults are used. Mid-session it is ignored instead, leaving the last good settings in place: an edit is seen the moment your editor touches the file, so an unreadable one is usually a half-finished save rather than what you meant.

## 🔐 What Plan mode does and does not enforce

Plan mode blocks exactly two tools while planning: `edit` and `write`. That is the whole enforcement surface. Checklist tools (a `todo` extension, for example) are deliberately not blocked — a task list is ephemeral planning scratch, and the planning prompt steers the model away from execution-progress tracking.

It deliberately does **not** police Bash, subagents, MCP tools, or any other extension tool. Those decisions belong to your permission layer, which can see the whole session and judge each call. Pair Plan mode with a permission extension such as `@hank-warren/pi-auto-permissions` if you want command review during planning.

The one exception is `plan_mode_question`, which Plan mode hides from the model when a better questionnaire is installed — see below. No other tool is ever added to or removed from the active set, so extensions that register tools lazily (MCP connections, subagent supervision channels) keep working normally and nothing needs to be restored when Plan mode exits.

## 🤝 Better questions with `pi-ask-user-question`

With [`@hank-warren/pi-ask-user-question`](../pi-ask-user-question) installed, Plan mode asks its decision questions through that tool instead:

```bash
pi install npm:@hank-warren/pi-ask-user-question
```

`plan_mode_question` renders through plain `ctx.ui.select` + `ctx.ui.editor`. `ask_user_question` gives the same decision points a real dialog: markdown **previews** on options, **notes** attached to a choice, several questions as **tabs** you cycle with Tab, **digit hotkeys**, and **checkbox multi-select**. It also allows 1-4 questions instead of 1-3, and 2-6 options on a multi-select question.

Detection is by tool name at runtime, re-evaluated every turn — there is no dependency between the two packages, and installing or removing one never requires touching the other. When `ask_user_question` is present:

- `plan_mode_question` is removed from the **active** tool set, so the model never sees two overlapping question tools and cannot call the weaker one. It stays *registered*, so a historical transcript still resolves it.
- The Plan-mode system prompt names `ask_user_question` and quotes its bounds and its decline signal.

A standalone `pi-plan-mode` install loses nothing: `plan_mode_question` stays fully functional and the prompt reads exactly as it always has. It is a **legacy fallback** and is slated for removal in a future major.

## 📚 The plan-craft doc

The system prompt is the enforcement surface and stays deliberately short. The depth layer it points at — what decision-complete actually means, why exploration comes before questions, what separates a question worth asking from one the repository already answered, and what belongs in a finished plan — is [`docs/plan-craft.md`](docs/plan-craft.md), shipped with the package. One line in the planning prompt names it by absolute path (resolved from the installed package, so it works under any install layout), and the model reads it when Plan Mode opens.

It used to be a skill. A skill's description line is in every system prompt, which buys exactly one thing an injected pointer cannot: the model proposing planning unprompted. Across ~220 sessions after it shipped, every read of the file happened after the Plan Mode prompt was already active, never off the description, and the model never suggested `/plan` on its own — so the line was a tax on every session that never planned (about 95% of them) that bought nothing. A hard path injected only while the mode is active is the same document at zero cost outside it.

## 📊 Statusline and widget

The footer status and the widget above the editor render from **one formatter**, so they cannot drift, and they share a glyph vocabulary with the sibling [`pi-loop`](../pi-loop): `◆` for a state wanting a decision, `▶` for work under way.

- `◆ plan · drafting` — planning is under way.
- `◆ plan · revising` — feedback superseded a completed plan; the stored one is not current.
- `◆ plan · ready → /plan` — a completed plan is waiting for your choice.
- `▶ plan · implementing` — a plan file is active and guiding implementation.

The widget adds a dim second line naming what to do next.

## 🗂️ Package layout

```txt
packages/pi-plan-mode/
├── index.ts              # Pi package entrypoint
├── src/
│   ├── plan-mode.ts      # Extension registration, mode state, hooks
│   ├── plan-file.ts      # Durable plan file read/write/delete
│   ├── interactive-ui.ts # Lazily loaded interactive menus
│   └── *.ts              # Prompt, question, export, settings modules
├── docs/plan-craft.md    # Plan-crafting depth, injected by path while the mode is active
├── test/
├── README.md
├── NOTICE.md
├── LICENSE
└── package.json
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
