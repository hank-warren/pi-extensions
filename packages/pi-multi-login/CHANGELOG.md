# @hank-warren/pi-multi-login

## 0.3.2

### Patch Changes

- c079c51: Make removing a `/multi-login` alias transactional, so a failure can never resurrect it.

  Removal now commits the alias-free config before touching any live registry, and deletes the credential last. A config write that fails leaves the alias list exactly as it was, so the operation is a complete no-op rather than a half-applied one, and no failure path can restore an alias the user just removed. Runtime and session unregister failures are non-fatal and report that a restart is required. The ordering lives in `removal.ts` and is tested at each failure stage.

## 0.3.1

### Patch Changes

- 3fbf632: Merge and publish the config atomically. `saveMultiLoginConfig` serialized a bare `{ aliases }` snapshot, deleting the unknown keys its own parser promises to tolerate, and wrote the live file in place — so a failed write could leave a config that no longer parses, which unregisters every alias with no path back, because the one-time credential adoption sees the file still exists. Now it re-reads and merges, then publishes through a temp file and a rename with owner-only permissions, matching every sibling settings writer.

## 0.3.0

### Minor Changes

- e5845ed: Stop driving OAuth flows from `/multi-login`; all sign-in now happens through Pi's own `/login`.

  Adding an alias registers it and notifies `Run /login and pick "<name>" to sign in` instead of opening a login dialog, and the "Log in again" row action is gone (re-authenticate through `/login` too). The previous inline dialog bridge could not render `select` auth prompts, which OpenAI Codex's OAuth flow now emits, so adding a Codex alias failed with an error directing to `/login` anyway — `/login` implements every prompt type, so it is now the single login path.

## 0.2.0

### Minor Changes

- 0e9400e: Add pi-multi-login: register additional OAuth logins for Pi's built-in providers under aliased provider ids (`openai-codex-work`, `anthropic-personal`), managed with a new `/multi-login` command.

  Aliases register during the extension load phase, so they resolve for `pi --list-models`, `pi --model provider/id` and `pi auth`, not just inside a session. Credentials written by an earlier owner of an alias id — notably pi-auto-permissions' `openai-codex-auto-permissions` — are adopted once into a visible, editable config file at `~/.pi/agent/pi-multi-login.json`.
