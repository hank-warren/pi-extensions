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

- **Automatic, once.** When the first turn of an unnamed session settles, the extension asks for a 3-5 word title and sets it as the session name. It makes one attempt per session and never replaces an existing name — one set with `/name`, inherited by a fork, or from an earlier run.
- **`/rename`** regenerates the name from the conversation as it stands now, replacing whatever is there. Use it when a long session has drifted, or to give a fork its own name. `/name <text>` still sets a name by hand.
- **Same model.** The title comes from the session's current model, at the session's current thinking level. There is nothing to configure.
- **Small input.** The model sees a digest of the current branch: the project directory, the first request, the last few requests, and the latest reply, each truncated to a few hundred characters.
- **Interactive only.** The automatic name is skipped in print, JSON, and RPC modes, which covers subagent children.

## What it touches

Nothing in the conversation. The title request is a standalone model call: it is not added to the transcript, never enters the model's context, and uses no session id or prompt-cache retention, so it cannot disturb the session's cache. The only write is the session name itself — the same `session_info` entry `/name` appends, which Pi never sends to the model.

Because the call bypasses the session, its token usage is not recorded in the session's usage totals.

## Licence

MIT
