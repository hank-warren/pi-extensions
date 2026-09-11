# @hank-warren/pi-tasks

Phased task tracking for [Pi](https://github.com/earendil-works/pi), driven by two tools.

The normal interaction is a conversation. You say what the work is; the agent calls `update_tasks`. You say how it changed; the agent calls `update_tasks` again and you get a review card with the actual diff. Nobody edits a Markdown file, invents a task id, or types a revision command.

```
you    "let's do this in three phases: schema, migration, then the cutover"
agent  update_tasks(mode: "apply", changes: [{ op: "init", phases: [...] }])
       → task set created, 3 phases, 9 tasks, ids allocated

agent  update_tasks(mode: "apply", changes: [{ op: "start", taskId: "t1" }])
agent  update_tasks(mode: "apply", changes: [{ op: "done", taskId: "t1",
         summary: "added the `revision` column with a backfill default" }])

you    "drop the cutover phase, we're doing that next quarter, but keep the
        migration work we already finished"
agent  update_tasks(mode: "propose", reason: "...", changes: [...])
       → review card: Accept revision · Request changes… · Cancel revision
```

## The tools

### `get_tasks`

Read-only. Returns the attached set's id, accepted revision, digest, phases and tasks with their exact ids and statuses, recorded completions, and any proposal waiting for review. `taskSetId` reads a different managed set without attaching to it.

### `update_tasks`

One atomic batch. Every change in it applies, or none does.

```jsonc
{
  "mode": "apply",            // or "propose"
  "taskSetId": "…",           // required for an existing set, from get_tasks
  "expectedRevision": 7,      // required for an existing set, from get_tasks
  "reason": "...",            // required for "propose"
  "changes": [ { "op": "done", "taskId": "t4", "summary": "..." } ]
}
```

Changing an existing set requires both `taskSetId` and `expectedRevision`. `init` needs neither, because it is what allocates them. A batch built against an older revision is **refused, not rebased**: the digest recheck under the lock already prevents a lost update, so this is about intent — a batch composed against revision 3 and quietly applied to revision 4 was never reviewed against the world it landed in.

| op | what it does |
| --- | --- |
| `init` | Creates a new set from nested phases and tasks. Must be the only change in its batch. |
| `add_phase`, `rename_phase`, `remove_phase` | Phase structure. `remove_phase` requires the phase to be empty. |
| `add_task`, `edit_task`, `move_task`, `remove_task` | Task structure. |
| `start`, `done`, `block`, `unblock`, `abandon`, `reopen` | Task lifecycle. |

`apply` commits immediately and is what routine progress uses. `propose` saves a candidate, shows the review card, and changes nothing unless the user accepts it.

The card is opened from inside the tool call, so `Esc` closes it: the tool's own cancellation signal is merged with the session and attachment generations, and a decision that arrives after the turn, the session, or the attachment has gone is dropped rather than published. Once a revision has been written it is published — there is no rollback, and a session that moved on in the meantime is told so (`published_but_detached`) instead of being handed someone else's task set.

### One candidate at a time

A corrected proposal **replaces** its predecessor: the replacement is written first, then the old candidate is retired as `superseded` with its content intact. So "request changes → propose again" leaves exactly one thing to decide, `/tasks review` reopens the corrected draft rather than the one that was rejected, and an obsolete candidate never latches "a revision is awaiting review" into every later turn. A candidate whose base the set has moved past is retired the same way — it can never be published again, and the agent is free to propose it afresh against the new revision.

Retired never means deleted. A superseded or cancelled proposal stays on disk, readable and re-proposable, and a card left over from an earlier round is re-checked against the stored record before it can publish anything.

## What it refuses, and why

- **Starting a second task.** At most one task is in progress. `start` on another refuses instead of quietly demoting the first, because "what am I working on" has one answer.
- **Closing a task without saying what was done.** `done` and `abandon` require a summary. It is a recorded assertion, not proof: nothing here verifies it.
- **Re-scoping or re-closing a closed task.** `reopen` must appear in the same batch. Reopening moves the recorded completion into history and says so on the diff, because historical completion is not verification of revised scope. A pure wording fix can pass `labelOnly: true` and keep the completion.
- **Replacing an attached set with `init`.** Detach it with `/tasks new` or file it with `/tasks archive` first.
- **Bulk deletion.** `remove_phase` will not take tasks with it.
- **Matching a task by its text.** Every targeted change names an exact id. A reworded task keeps its identity and its history; a fuzzy match would silently orphan both.

## Where it lives

```
~/.pi/agent/tasks/<task-set-id>/
  tasks.md                 the accepted document
  revisions/<n>.md         an immutable snapshot of every accepted revision
  revisions/orphan-*.md    a snapshot an interrupted transaction prepared and
                           never published — retained, never accepted history
  proposals/<id>.json      candidates, pending and resolved
  tasks.lock               the cross-process lock
```

`tasks.md` is readable Markdown with `[ ] [/] [!] [x] [-]` status markers and HTML-comment annotations carrying ids and completions. Lines the parser does not recognise are preserved verbatim in place, so a status-only update leaves the rest of the document alone.

Three layers guard a write: an in-process queue per path, a [`proper-lockfile`](https://www.npmjs.com/package/proper-lockfile) lock around the whole read-validate-write window, and a SHA-256 digest of the bytes the change was computed from, rechecked under the lock immediately before the rename.

**That is optimistic conflict detection, not a filesystem compare-and-swap.** A writer that ignores the lock — an editor, another tool — can change the file between the digest check and the rename, and no POSIX filesystem prevents it. What the digest buys is that the next read *notices*, stops mutating, and asks a human, instead of merging silently. Every accepted revision is still under `revisions/`.

The snapshot lands before the live document is renamed, so a crash between the two leaves a snapshot for a revision the live document never reached. That snapshot was *prepared*, never accepted — accepted history is exactly the revisions the live document has reached — and the next write resolves it rather than wedging: identical bytes are an idempotent resume, anything else is moved aside under an `orphan-` name and reported. Nothing is deleted, no accepted snapshot is ever overwritten, and approval is never inferred from bytes nobody published.

## The session's side

The session records only a pointer: which set, which revision, which digest. It is a custom entry, so it never enters model context and survives compaction for free. The model sees one line per turn naming the file and the open/total counts, and calls `get_tasks` when it needs more.

An ordinary new session inherits nothing. Restoring task state never rewinds source code.

When the document and the recorded pointer disagree, mutation stops until `/tasks recover`, which offers exactly three choices: attach the document as it stands, fork the newest snapshot into a **new** set (nothing on disk is overwritten), or detach. A revision this session has not seen is *not* a conflict when the document is byte-identical to the snapshot of its own revision — that is what a cooperating session's commit leaves behind, and it is followed with a notice.

## `/tasks`

For the human: `show`, `review`, `new`, `archive`, `export <path>`, `recover`. Bare `/tasks` opens the menu. There is deliberately no command that edits tasks — that is `update_tasks`, and a second editing interface is one the model would start recommending.

`archive` refuses while any task is open; it never closes work for you. `export` writes a copy and does not touch the accepted set, and will not overwrite an existing file.

## Known limitations

- **Resolved proposals are never pruned.** The pending scan reads every file under `proposals/`, and it runs on each read, write, and turn boundary. Proportional to how many revisions a set has ever proposed, not to how many are open. An index or a `resolved/` subdirectory would bound it; that is deferred rather than done here, because it is a storage-layout change and this is not the round for one.
- **The containing directory is not fsynced after the rename.** The document is fsynced before it; recovery covers the remaining window.
- **No live canary.** Every test here mocks `ExtensionAPI`, so nothing in this package proves what a model *chooses* to call, or how the card renders in a real terminal.
- A line you type into `tasks.md` by hand is preserved verbatim, but it is never promoted to a task — `/tasks recover → attach` keeps it as a note, not as work.

## Install

```bash
pi install npm:@hank-warren/pi-tasks
```

Requires Node >= 22.19.0. Works standalone; it does not depend on Plan mode or any other extension.

## License

MIT. See [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md).
