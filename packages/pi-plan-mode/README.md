# 🧭 pi-plan-mode — Plan mode for Pi

[![npm](https://img.shields.io/npm/v/@hank-warren/pi-plan-mode)](https://www.npmjs.com/package/@hank-warren/pi-plan-mode) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@hank-warren/pi-plan-mode` adds a `/plan` mode to Pi for research and design. You gather information, ask questions, and land on a plan — then implement it, either in the same conversation or in a fresh one.

**Plan mode is a mode of intent, not a permission system.** It blocks `edit` and `write` while planning and leaves every other tool exactly as you configured it. Command safety stays with your permission extension (for example [`@hank-warren/pi-auto-permissions`](../pi-auto-permissions)), which already reviews Bash. The only tool Plan mode ever removes from the active set is its own `plan_mode_question`, and only when a better questionnaire is installed (see below), so it cannot break other extensions.

The plan is written to a **durable file** that survives compaction, survives resume, and can be hand-edited.

## ✨ Features

- `/plan` mode with a planning system prompt: explore first, ask decision questions, do not implement.
- `plan_mode_question` for structured 1-3 question decision points with options and a free-form path — or `ask_user_question` when that is installed (see below).
- `plan_mode_complete({ plan })` writes the plan to `<agent dir>/plans/<session-id>.md`.
- `update_plan` revises a plan that already exists, conversationally: you ask for the change, the agent rewrites the plan, and you accept, send it back, or cancel on a card showing the **computed diff**. See [Revising an existing plan](#-revising-an-existing-plan).
- **Once a plan exists, `plan_mode_complete` refuses it.** It carries a whole plan and no base revision, which is right for a first draft and wrong for a change to an agreed plan, so it names `update_plan` instead of replacing reviewed scope from model memory.
- **Approval binds to bytes.** Choosing to implement records the digest of the exact plan it approved; a plan whose file changed afterwards, or one this session never approved, is reported as unverified, **mutating tools are refused**, and it cannot be marked implemented until you resolve it.
- **Pointer, not payload.** An active plan adds two lines to the system prompt: the file to read, and how to change it. The plan body is never injected into context, so a 50-page plan costs the same as a one-liner and survives compaction for free.
- Two ways to implement: continue in this conversation, or open a fresh session that reads the same file.
- `plan_implemented` lets the model end implementation itself once the plan's verification has passed; `/plan done` does the same by hand. The plan file is **archived**, never deleted, so a session that plans several times keeps every plan.
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
                      (during a revision: review it, cancel it, or keep going;
                       while implementing an unverified plan: confirm the file)
/plan start           enter Plan mode without sending a prompt
/plan <prompt>        enter Plan mode and start planning <prompt>
/plan show            display the stored plan
/plan finalize        ask the agent to complete the plan now
/plan implement       implement the completed plan here
/plan done            mark the active plan implemented and archive it
/plan export [path]   copy the plan to a Markdown file
/plan exit            leave Plan mode and delete the plan file
```

`--plan` starts a session directly in Plan mode.

While Plan mode is active, ask the agent to design the change. It can read, search, and run commands, but `edit` and `write` are blocked. When the plan is decision-complete, the agent calls `plan_mode_complete` and the plan is written to disk.

A first draft is not final until you act on it: just type feedback to revise — the next planning turn supersedes the proposed plan, and the next `plan_mode_complete` replaces it.

That applies to a plan that has no history yet. Once a plan has been revised or approved it has a managed identity, and changing it goes through `update_plan`, which keeps a reviewable history: `plan_mode_complete` refuses for such a plan and says which call to use. `/plan finalize` follows the same rule, asking for whichever call will actually be accepted. See [Revising an existing plan](#-revising-an-existing-plan).

From a completed plan you can:

- **Implement here** — Plan mode turns off and implementation continues in this conversation.
- **Start fresh and implement** — a new linked session opens, pointed at the same plan file, without carrying the planning conversation.
- **Export plan…** — write the plan to a path of your choice.
- **Stay in Plan mode** — keep refining. The next planning turn supersedes the previous plan.

### Ending implementation

While a plan is being implemented the footer shows `▶ plan · implementing` and the system prompt carries a one-line pointer to the plan file. Implementation ends in one of three ways:

- **The model calls `plan_implemented`** once the plan's verification steps have passed. It is staged into the tool set the moment implementation starts and is told to call it once, as the last action, not to keep checking whether the plan is done.
- **`/plan done`**, or **Mark as implemented** from the `/plan` menu.
- **Start a new plan** from the same menu, which ends the current one on its way into Plan mode.

All three archive the plan file to `plans/<session-id>.<n>.md` beside the live slot and clear the pointer. **Clear active implementation plan**, `/plan exit` and `/plan off` delete instead of archiving.

An archive that fails (a filesystem without hard links, a permissions error, a plan file replaced while it was being archived) is reported and changes nothing: the plan stays active, and you can export and clear by hand. If the session moved on while the archive was in flight — a `/plan start`, a session replacement — the newer state wins and the finish is dropped.

A **fresh implementation session shares its parent's plan file**, so when it finishes, the parent's pointer names a file that has moved. The parent notices on its next start, clears the pointer, and remembers the archive: `/plan show` there displays the archived plan as history.

Print and JSON modes cannot show the interactive menu; use `/plan start`, `/plan <prompt>`, `/plan show`, `/plan export`, and `/plan exit` there.

## 🔁 Revising an existing plan

Once there is a plan, you change it by **saying what you want changed**. Not by editing Markdown, not by running a revise command:

> change the deployment approach to a rolling restart, but keep the migration work

The agent calls `update_plan` twice. `action: "begin"` opens a revision — the approved plan is kept exactly as it is, Plan mode's non-mutation rules come back (so `edit` and `write` are blocked from the next tool call onward), and your request is recorded with the revision. The agent then re-reads the plan, asks only what the change actually raises, and calls `action: "propose"` with the **complete rewritten plan**.

Proposing opens a review card, in the same turn, without any command from you:

- **Accept revision** — it becomes the current plan, and you then choose how to implement it.
- **Request changes…** — your words go back to the agent, which proposes again. The rejected candidate is retired and kept on file.
- **Show the changes / Show the proposed plan** — the computed diff, and the full text.
- **Cancel revision** — the approved plan and its approval are untouched.

The card shows a diff **this package computed** from the two documents, with the agent's `changeSummary` beside it, clearly labelled as the agent's account. A summary cannot be wrong about itself; a diff can. There is no classifier deciding which changes are "material" — you read the change and decide.

Closing the card without choosing is not a decision: the candidate waits, implementation stays paused, and `/plan` → **Review the proposed revision** reopens it. A headless session (print, JSON) cannot show a card, so it saves the candidate and reports `pending_review` rather than inventing an approval.

Accepting makes the revision **current but not yet approved**: the same "what next?" menu a completed plan opens appears, and choosing to implement is what approves those exact bytes. Cancelling leaves execution paused the same way, so nothing silently resumes against a plan you were in the middle of changing.

While a revision is open, everything that would claim the plan is finished refuses and says why: `plan_implemented`, `/plan done`, and the menu's completion items. `/plan exit` during a revision abandons the revision but **keeps the agreed plan file** — it is not the discarded draft that exit normally means — retires the candidate, and leaves nothing implementing until you pick the plan back up. `/plan implement` refuses rather than approving bytes you are still changing.

### Revision history

The live plan file stays where it always was. Beside it, `<agent dir>/plans/.revisions/<plan-id>/` holds the record:

```txt
plans/.revisions/<plan-id>/
├── manifest.json          which revision the plan file is, and the history index
├── revisions/<n>.md       the immutable snapshot of revision n
├── proposals/<id>.json    candidates, including the ones you rejected
├── external/<digest>.md   bytes found in the plan file that this package did not write
└── manifest.lock          the cross-process lock
```

A plan gains a history the first time something managed happens to it — a revision, or an approval — never in bulk at session start, and **from the bytes the file actually holds**: no trailing newline is added and no line ending is rewritten, because a digest over anything else would report a change nobody made. (Candidates the agent authors get the trailing newline on their way in; every comparison against live or accepted content is raw-byte.) Nothing here is ever overwritten: revision numbers are allocated past everything ever reserved, so gaps are normal and a number is never reused. Clearing a plan from a session clears the session's pointer, not the record.

Publication order is: prepare the candidate bytes and a record of what they are, replace the plan file, then write the snapshot and the manifest. A crash between the second and third steps is repaired at the next session start — but only on evidence that this package published exactly those bytes *and has not finished doing so*: the record must name a revision above the one the manifest holds and not already be in its history. Without that, a plan revised and then rolled back would let the old revision's record explain any later reappearance of its bytes, and an outside edit would be reported as a recovered publication. Plan-file contents that no record explains are **not** adopted as a revision and never count as approval: they are reported, kept, and left for you to reconcile (by asking for a revision) or confirm (from `/plan`).

If a plan's history directory disappears while a revision is open, the revision is invalidated rather than left half-usable — asking for the change again starts a fresh history. Every candidate and snapshot still on disk is kept.

`proper-lockfile` serialises two cooperating Pi sessions revising one plan, and the base digest is rechecked under the lock immediately before the plan file is replaced. That is optimistic conflict detection, not a compare-and-swap: an editor that ignores the lock and rewrites the file between the check and the rename wins. What is promised is that such a write is *detected* at the next read, and that every revision this package published is still on disk.

### When approval cannot be verified

Approval is the digest of the bytes you approved, so two situations read as unverified:

- **The plan file changed after it was approved** — a hand-edit, or another session.
- **This session never recorded an approval** — a plan carried in from a version before managed approval.

Either way the footer becomes `▶ plan · unverified → /plan`, the system prompt tells the model not to claim the plan was implemented, **`edit` and `write` are refused**, and every completion path refuses. Two things resolve it, both deliberate: ask for a revision (`update_plan` reconciles the file, and accepting it records the result), or `/plan` → **Confirm the plan file**, which records the file exactly as it is as approved and as a revision in its history. Nothing resolves it automatically, and no model-callable tool can bypass it.

The digest is compared at three moments, not one: at the start of every turn, before every mutating tool call, and at completion. The middle one is what catches an edit that lands *between* two tool calls in the same turn — without it, the rest of that turn would carry out a plan nobody agreed to and only the next turn would notice.

### Branch navigation

Approval is recorded in the session branch, so `/tree` navigation re-reads it: moving to a branch taken before you approved anything reports no approval, and a branch that never had a plan reports no plan. Nothing on disk is rewound — the plan file and its recorded revisions are left exactly as they are, and a plan whose bytes no longer match what the selected branch approved becomes unverified rather than being reverted. Menus and waits opened against the previous branch are superseded first, so a decision made there cannot land here.

## 📄 The plan file

The plan lives at `<agent dir>/plans/<session-id>.md` — normally `~/.pi/agent/plans/<session-id>.md`.

- **It is the plan.** Session state stores only the path.
- **Hand-edit it freely.** Everything reads from disk, so your edits are what the agent implements.
- **It survives compaction** because the model only ever sees a one-line pointer to it, and re-reads the file when needed.
- **A fresh implementation session points at the same file.** The plan is never copied, so both sessions see the same content.
- **Finishing archives it** to `<session-id>.<n>.md` in the same directory, numbered upward, so the next plan in the session gets a clean slot without overwriting the last one.
- `/plan exit` on a *proposed* plan deletes it. Export first if you want to keep a copy. Its recorded revisions under `.revisions/` are kept either way.
- **A hand-edit is still read, and now also noticed.** Everything reads from disk as before, and an edit that moves the file away from the bytes you approved is reported instead of passing silently.

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

Plan mode judges exactly two tools, `edit` and `write`, and judges them twice for different reasons. While planning or revising they are blocked outright: planning must not mutate files. While *implementing* they are allowed only if the plan on disk is still the plan you approved — that is the per-mutation half of the digest check described above.

That is the whole enforcement surface, and it does not grow. Bash, MCP tools and subagents are deliberately not inspected: Plan mode cannot tell which of those write, and guessing would be worse than leaving the decision to your permission layer. Read-only tools are never touched. The cost of the implementation-time check is one read of the plan file per `edit`/`write` while a plan is active.

Its own tools are **staged, and never withdrawn mid-session**: `plan_mode_complete` joins the active set when Plan mode is entered, `update_plan` joins as soon as a plan file exists, `plan_implemented` joins when implementation starts, and each stays until the session ends, refusing to run outside its phase. Staging happens on the `input` event, before Pi snapshots the base system prompt for the turn, so a staged tool ships with its guideline on the same turn rather than the next. Each join lands on a transition that already rewrites the system prompt, so a plan's whole lifecycle changes the **tool list** three times, at moments the mode switch was paying for anyway. The system prompt itself changes at those two moments and once more when implementation ends (the pointer line leaves); nothing else Plan mode does changes either between turns.

The one exception is the `plan_mode_question` fallback, which follows `ask_user_question`'s availability and so can leave and rejoin when that changes mid-session (a headless turn, or the package being installed or removed) — rare, and older than this design. Checklist tools (a `todo` extension, for example) are deliberately not blocked — a task list is ephemeral planning scratch, and the planning prompt steers the model away from execution-progress tracking.

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
- The Plan mode system prompt names `ask_user_question` and quotes its bounds and its decline signal.

A standalone `pi-plan-mode` install loses nothing: `plan_mode_question` stays fully functional and the prompt reads exactly as it always has. It is a **legacy fallback** and is slated for removal in a future major.

## 📚 The plan-craft doc

The system prompt is the enforcement surface and stays deliberately short. The depth layer it points at — what decision-complete actually means, why exploration comes before questions, what separates a question worth asking from one the repository already answered, and what belongs in a finished plan — is [`docs/plan-craft.md`](docs/plan-craft.md), shipped with the package. One line in the planning prompt names it by absolute path (resolved from the installed package, so it works under any install layout), and the model reads it when Plan mode opens.

It used to be a skill. A skill's description line is in every system prompt, which buys exactly one thing an injected pointer cannot: the model proposing planning unprompted. Across ~220 sessions after it shipped, every read of the file happened after the Plan mode prompt was already active, never off the description, and the model never suggested `/plan` on its own — so the line was a tax on every session that never planned (about 95% of them) that bought nothing. A hard path injected only while the mode is active is the same document at zero cost outside it.

## 📊 Statusline and widget

The footer status and the widget above the editor render from **one formatter**, so they cannot drift, and they share a glyph vocabulary with the sibling [`pi-loop`](../pi-loop): `◆` for a state wanting a decision, `▶` for work under way.

- `◆ plan · drafting` — planning is under way.
- `◆ plan · revising` — a revision of an existing plan is being written, or feedback superseded a completed plan; the stored plan is not current.
- `◆ plan · revision ready → /plan` — a proposed revision is waiting for your decision.
- `◆ plan · ready → /plan` — a completed plan is waiting for your choice.
- `▶ plan · implementing` — a plan file is active and guiding implementation.
- `▶ plan · unverified → /plan` — implementing a plan whose approval cannot be verified.

The widget adds a dim second line naming what to do next.

## 🗂️ Package layout

```txt
packages/pi-plan-mode/
├── index.ts              # Pi package entrypoint
├── src/
│   ├── plan-mode.ts               # Extension registration, mode state, hooks
│   ├── plan-file.ts               # Durable plan file read/write/archive
│   ├── revision-store.ts          # Manifest, snapshots, proposals, locking, recovery
│   ├── plan-revision-controller.ts # update_plan begin/propose, review, approval
│   ├── plan-diff.ts               # The computed diff the review card shows
│   ├── interactive-ui.ts          # Lazily loaded interactive menus
│   └── *.ts                       # Prompt, question, export, settings modules
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
