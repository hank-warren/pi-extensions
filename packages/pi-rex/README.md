# pi-rex

Pi agents in [Rex](https://www.superlogical.com/rex) tabs. A Pi session running in a Rex terminal starts each child as a full interactive Pi in its own tab, which you can watch and type into. Each child's results, blocks and exits arrive in the parent session as messages, so the parent never polls a screen.

```bash
pi install npm:@hank-warren/pi-rex
```

Requires the `rex` CLI and a Pi that runs inside a Rex terminal (`REX_SESSION` is set). Outside Rex the tools are withdrawn.

## Tools

| Tool | What it does |
|---|---|
| `RexSpawn` | Start a child: `task`, plus optional `name`, `cwd`, `template`, `model`, `thinking`, `tools` (an allowlist) and `placement`. Returns at once. |
| `RexSend` | Message a child by name. A working child gets it as steering after its current tool calls; a finished one starts a new turn with it. |
| `RexRead` | Read the end of a child's terminal screen, for a child that is blocked or silent. |
| `RexStop` | Close a child's tab, ending its Pi. |
| `RexList` | List the children and their states. |

When the session has `codemode`, the tools are registered with Pi's `codemode` exposure and the model calls them from scripts. Without codemode they are ordinary tools.

A child starts in a **new, unfocused tab** of the parent's Rex session, labeled with its name. `placement: "split"` puts it in a pane to the right of the parent instead. Either way your focus stays where it is.

A child is started with the parent's own Pi binary and any `-e` extensions the parent was started with, in the environment of your login shell, so it loads your normal extensions, skills and `AGENTS.md`. Without `model`, it uses Pi's default model.

## What the parent receives

Messages tagged `<rex-child>`, each naming the child and its state:

| State | When | Wakes the parent |
|---|---|---|
| `done` | A run of the child settled. The body is its last assistant message. | yes |
| `error` | A run ended in an error. | yes |
| `interrupted` | A run was interrupted in the child's tab. | yes |
| `blocked` | The child is waiting on you in its tab: a permission prompt, a question, a login. Carries the prompt's kind and text. | yes |
| `exited` | The child's tab closed. | yes, unless `RexStop` closed it |

A report longer than 40,000 characters is cut, and the whole text is saved to a file the message names.

The parent has no tool that types into a child's terminal, so it cannot answer a child's permission prompt or question. A `blocked` message tells it which tab needs you.

`done` means a turn ended, not that the task is finished: a child that stops to ask something in plain text reports that as its result, and the parent can answer with `RexSend`.

## How it works

- **Status** comes from Rex. Pi reports what it is doing to the terminal (the program status protocol, OSC 7501), and the parent follows `rex events` for its children's blocks and exits.
- **Results and messages** go through a spool directory per child under `<agent dir>/pi-rex/<session id>/<name>/`. The child's side of this extension writes the last assistant message there when a run settles; the parent's side writes messages for the child, which the child delivers to itself as user messages. Nothing is typed into a terminal.
- **The task** is written to `task.md` in that directory and passed to the child as `pi @task.md`.

A child registers none of these tools, so it cannot start children of its own.

`tools` (or a template's `--tools`) is an allowlist the child enforces on every tool call, including calls its codemode scripts make. Pi's `--tools` flag alone only chooses which tools are declared to the model; MCP and codemode-exposed tools would stay callable from scripts.

Children keep running when the parent session ends. Their reports wait on disk, and a resumed session (`pi --continue`) finds its children again: reports that arrived meanwhile are stored in the conversation without starting a turn, and a child whose tab has closed is marked exited.

## Templates

`template: "<name>"` reads `<agent dir>/pi-rex/templates/<name>.md`, then `~/.config/herdr-core/templates/<name>.md`. The format is the one herdr-core uses: frontmatter with a `command` that starts with `pi`, then instructions.

```markdown
---
name: reviewer
description: Read-only review of a diff.
command: pi --model provider/model:high --tools read,bash,grep,find,ls
---

You review diffs for correctness bugs. Report file:line, severity and a fix.
```

The arguments after `pi` are passed to the child, and the instructions are placed before the task. `model`, `thinking` and `tools` passed to `RexSpawn` come after the template's and win.
