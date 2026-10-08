# @hank-warren/pi-auto-name

Names each [Pi](https://pi.dev) session after the work it is doing, so `/resume`, the terminal title, and anything that reads it (such as [Herdr](https://herdr.dev)'s agent list) show `statusline cache fix` instead of a blank or a directory name.

## Install

```bash
pi install npm:@hank-warren/pi-auto-name
```

Try it for a single run without installing:

```bash
pi -e npm:@hank-warren/pi-auto-name
```

Do not install this standalone package on a host that also installs the aggregate `hank-warren/pi-extensions` Git package; that would load the extension twice.

## Behaviour

- **Automatic, and it keeps up.** When the first turn settles, the extension asks for a 3-5 word title and sets it as the session name, then refreshes it after every second turn (turns 1, 3, 5, …), so the name follows a session that drifts. An unchanged title writes nothing. The count restarts when a session is resumed.
- **Hand-set names stick.** Automatic renames only replace a name the extension set itself (it records which, so this survives resume and fork). A name set with `/name`, or one that predates the extension, is left alone.
- **`/rename`** regenerates the name from the conversation as it stands now, replacing whatever is there, and hands the name back to the automatic renames. `/name <text>` still sets a name by hand.
- **Same model.** The title comes from the session's current model, at the session's current thinking level. There is nothing to configure.
- **Small input.** The model sees a digest of the current branch: the project directory, the first request, the last few requests, and the latest reply, each truncated to a few hundred characters.
- **Interactive only.** The automatic name is skipped in print, JSON, and RPC modes, which covers subagent children.

## Herdr

Inside a [Herdr](https://herdr.dev) pane the name is also reported as the pane token `session_name`, so a sidebar row can show just the name, without the `π - … - <dir>` decoration pi puts in the terminal title. Add it to the Agent rows in the Herdr config of the machine you view the sidebar from (with `herdr --remote`, that is the local client):

```toml
[ui.sidebar.agents]
rows = [
  ["workspace", "state_icon", { token = "state_text", dim = true }],
  [{ token = "$session_name", dim = true }],   # hidden while the session is unnamed
]
```

The token follows every name change — the automatic name, `/rename`, `/name`, a resumed or forked session — and is cleared when pi quits. Reports are single short socket writes to the pane's own Herdr server, bounded by a 500 ms timeout; failures are ignored. Outside Herdr nothing is sent.

## What it touches

Nothing in the conversation. The title request is a standalone model call: it is not added to the transcript, never enters the model's context, and uses no session id or prompt-cache retention, so it cannot disturb the session's cache. The only session writes are the name itself — the same `session_info` entry `/name` appends — and a small `pi-auto-name` custom entry recording which name the extension set. Pi sends neither to the model.

Because the call bypasses the session, its token usage is not recorded in the session's usage totals.

## Licence

MIT
