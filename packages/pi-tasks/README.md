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
  tasks.md                        the current document
  revisions/<n>.md                the snapshot of revision n
  revisions/pending-<n>-<id>.md   bytes prepared for revision n
  revisions/pending-<n>-<id>.json the record of what they are
  proposals/<id>.json             candidates, pending and resolved
  tasks.lock                      the cross-process lock
```

`tasks.md` is readable Markdown with `[ ] [/] [!] [x] [-]` status markers and HTML-comment annotations carrying ids and completions.

Lines the parser does not recognise are kept and written back where they were, blank lines within them included, so a note keeps its paragraphs across a status-only update. This is line-level preservation of unrecognised content, not byte-level preservation of the whole document: the title, the metadata comment and the separators around headings and task blocks are regenerated on every write, and a task line is re-serialized from the structure rather than echoed.

Three layers guard a write: an in-process queue per path, a [`proper-lockfile`](https://www.npmjs.com/package/proper-lockfile) lock around the whole read-validate-write window, and a SHA-256 digest of the bytes the change was computed from, rechecked under the lock immediately before the rename.

**That is optimistic conflict detection, not a filesystem compare-and-swap.** A writer that ignores the lock — an editor, another tool — can change the file between the digest check and the rename, and no POSIX filesystem prevents it. What the digest buys is that the next read *notices*, stops mutating, and asks a human, instead of merging silently.

The lock is also a lease, and a lease can be lost. If this process stalls past the stale window — a sleeping laptop, a suspended process, a slow agent dir — a cooperating session may legitimately reclaim the lock while this one still believes it holds it. That is reported through a handler which **records** the loss: the commit then refuses to publish, and a loss noticed after the rename is reported as published-with-history-pending rather than as a change that did not happen. (The library's default handler throws from its refresh timer, which in Pi's interactive mode ends the session; installing one is what stops a stalled session killing the editor.)

**The lease is not fencing.** The check and the write are not one atomic operation, so a lease lost in the instant between them is not caught, and nothing here constrains a writer that never takes the lock at all. It narrows a real crash and a real write-without-ownership window; it is not a distributed lock.

### Why a numbered snapshot can be trusted

Publication is the rename of `tasks.md`, and nothing else. A revision is prepared first, under `pending-<n>-<id>`, alongside a record of its identity, revision and digest; the rename publishes it; only then are the bytes linked to `revisions/<n>.md`. Because the snapshot is created *after* the rename, a `<n>.md` this package wrote always means "published".

Nothing renames, replaces or reassigns a numbered snapshot, for any reason. Revision numbers are allocated past everything ever reserved — finalized snapshots and preparations alike — so a number consumed by an interrupted or rolled-back publication is never handed out again. **Gaps in the numbering are normal**; a reused number would not be.

A crash between the rename and the link leaves the revision published with its snapshot missing. That is repaired only on evidence: a preparation record naming this set, this revision, and the digest the live document is holding. Bytes that merely parse are never evidence, and a snapshot that already disagrees is never displaced — the conflict goes to recovery instead.

Snapshots written by versions of this package before that record keeping existed cannot be proven to have been published. They are preserved and their numbers stay reserved, and recovery will offer their content, but it says plainly that it cannot prove they were published rather than merely prepared.

If history on disk runs ahead of the document — after a restore from backup, say, or a document rolled back over work another session had already published — the set stops accepting changes and asks. Attaching the current document records how much history was accounted for, so the next change is numbered above it and the session carries on; the revisions it passed over stay exactly where they were. A restore that is indistinguishable from normal state cannot be detected at all, which is the documented limit rather than a promise.

Durability is fsync-on-the-file before each rename. The containing directory is not fsynced, so what is promised is ordering and no-clobber, not surviving a power loss on a filesystem that reorders directory entries.

## The session's side

The session records only a pointer: which set, which revision, which digest. It is a custom entry, so it never enters model context and survives compaction for free. The model sees one line per turn naming the file and the open/total counts, and calls `get_tasks` when it needs more.

An ordinary new session inherits nothing. Restoring task state never rewinds source code.

When the document and the recorded pointer disagree, mutation stops until `/tasks recover`, which offers exactly three choices: attach the document as it stands, fork the newest snapshot into a **new** set (nothing on disk is overwritten), or detach. A revision this session has not seen is *not* a conflict when the document is byte-identical to the snapshot of its own revision — that is what a cooperating session's commit leaves behind, and it is followed with a notice.

## `/tasks`

For the human: `show`, `review`, `new`, `archive`, `export <path>`, `recover`. Bare `/tasks` opens the menu. There is deliberately no command that edits tasks — that is `update_tasks`, and a second editing interface is one the model would start recommending.

`archive` refuses while any task is open; it never closes work for you. `export` writes a copy and does not touch the accepted set, and will not overwrite an existing file.

## Plans and bound tasks

With `@hank-warren/pi-plan-mode` loaded, a plan can own a dedicated task set. The plan agent derives a structured task seed; you review the plan and task changes together. Initial binding preserves any unrelated standalone set on disk rather than resetting it.

- `get_tasks` still reports the exact IDs, revision, statuses, evidence and binding.
- Routine progress uses `update_tasks(mode: "apply")` as before.
- Bound scope changes or `mode: "propose"` return `requires_plan_revision`, the current binding and the proposed changes. The agent uses `update_plan(begin/propose)` to reconcile both artifacts; a missing plan owner is not permission to bypass it.
- Reconciliation matches IDs only. New items receive IDs, removals retain history, and changed closed work requires explicit reopening. A recorded completion is not proof of revised work.
- Binding uses the same locked snapshot store. Its persisted request fingerprint makes exact retries idempotent even after subsequent progress. Conflicting reuse and stale revisions refuse without overwriting work.
- Plan completion re-reads the bound set and refuses open work. Explicitly abandoned work is terminal and counted separately.

The versioned request/response bridge has no new model-facing tool and no dependency on the companion extension. Fresh-plan handoff writes and validates the task attachment before kickoff; ordinary new sessions remain unattached. See the [plan-mode integration notes](../pi-plan-mode/README.md#connected-plan-and-task-tracking) for partial-publication and provider-failure behavior. Live integration canaries remain pending before release.

## Known limitations

- **Resolved proposals are never pruned.** The pending scan reads every file under `proposals/`, and it runs on each read, write, and turn boundary. Proportional to how many revisions a set has ever proposed, not to how many are open. An index or a `resolved/` subdirectory would bound it; that is deferred rather than done here, because it is a storage-layout change and this is not the round for one.
- **The containing directory is not fsynced after the rename.** The document is fsynced before it; recovery covers the remaining window.
- **Preparations and their records are never pruned.** Every revision leaves a small JSON record, and an interrupted publication also leaves its candidate bytes. They are what reserve the number and what later proves a publication happened, so nothing here deletes them; a set with a long history accumulates one small file per revision.
- **A crash during a commit needs one explicit recovery.** The reservation it left is indistinguishable from a publication that landed and was then rolled back, so the set asks rather than guessing. `/tasks recover → attach` clears it and the next change is numbered above the gap.
- **A concurrent commit can briefly look like that ambiguity.** A session reading in the window between another session's reservation and its rename sees history above the document and asks for recovery. Attaching resolves it; nothing is lost either way.
- **No live canary.** Every test here mocks `ExtensionAPI`, so nothing in this package proves what a model *chooses* to call, or how the card renders in a real terminal.
- A line you type into `tasks.md` by hand is kept as a note and written back in place, but it is never promoted to a task — `/tasks recover → attach` keeps it as text, not as work.

## Install

```bash
pi install npm:@hank-warren/pi-tasks
```

Requires Node >= 22.19.0. Works standalone; it does not depend on Plan mode or any other extension.

## License

MIT. See [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md).
