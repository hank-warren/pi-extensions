# pi-plan-mode

The extension enforces the mechanics: `edit` and `write` are blocked, the plan is written to a durable file, and `plan_mode_complete` is the only way out. It cannot enforce the thing that decides whether the plan was worth making: **whether a competent implementer could execute it without asking you anything.** That is this file.

## What "decision-complete" means

A plan is finished when every decision it depends on has been made — by discovery, by the user, or by an explicitly recorded assumption. It is not finished when it is long, well organised, or reads confidently.

The test: hand the plan to someone who was not in the conversation. Every place they would have to stop and ask "which one?" is an unresolved decision, and every one of those is a defect. That includes:

- which of two plausible approaches is being taken, and why the other was rejected;
- the names and shapes of anything new — files, functions, types, settings keys, tool parameters;
- what happens on failure, and what happens to state that already exists;
- how the change is verified, in the form of the commands to run and what they should print;
- what deliberately stays out of scope.

An unresolved decision hidden behind a confident sentence is worse than an open question, because nobody will notice it until implementation stalls.

## Phase 1: explore before asking

Read the repository first, every time. Questions are expensive — they cost the user's attention and they interrupt — so spend them only on what the code cannot tell you.

Facts the environment owns: what already exists, how the neighbours solve the same problem, what the tests cover, what conventions the repo files and `AGENTS.md` impose, what versions are pinned, what a command actually prints. **Never ask about any of them.** A question whose answer was one `rg` away tells the user you did not look, and it trains them to stop answering carefully.

Facts the environment does not own, and only the user does: product intent, priorities and tradeoffs, what "good enough" means here, which of two acceptable designs they want to live with, whether a breaking change is acceptable, deadlines and blast-radius tolerance.

Exploration also earns the right to disagree. A plan that says "this repo already does X three times, so the fourth should match" is grounded; one that invents a new pattern in a codebase that already has one is a plan the reviewer has to fight.

## Phase 2: ask questions worth answering

Use the question tool for the decisions that are genuinely the user's. Good questions share a shape:

- **The options are real and mutually exclusive.** If one option is obviously right, it is not a question — it is a decision, and you should state it and move on.
- **Each option says what happens if it is chosen**, not just what it is called. "Store it in the session entry (survives restart, costs a write per turn)" is a choice; "session entry" is a label.
- **The recommendation comes first and is marked**, so a user who trusts you can answer in one keystroke and one who does not has the alternatives in front of them.
- **The question is answerable without reading the codebase.** If answering it requires knowing what a function currently does, that is your job, not theirs.

Batch decisions that belong to one choice into one call rather than dripping them out over several turns, and stop asking as soon as the remaining ambiguity is low-impact. When the user declines to answer, do not silently pick: state the default you are taking, mark it as an assumption in the plan, and keep the alternative visible.

A high-impact ambiguity is a reason to keep planning, never a reason to write a plan that hedges. A plan with two branches in it is two plans and nobody's decision.

## Phase 3: write the plan

The plan is read by a human deciding whether to approve it and by an agent executing it. Both want the same thing: grouped, behaviour-level changes with the reasoning attached.

Structure that works:

- **Title and a short summary** — what changes and why, in a few sentences.
- **The approach**, including the alternatives considered and why they lost. This is the part that survives contact with the implementation; the file list is not.
- **Behaviour, interface, and data changes** — what a caller or user sees differently, and what the new names and shapes are.
- **Edge cases and failure modes**, including what happens to existing state and how the change behaves on a host that has the old version.
- **Verification** — the commands to run and what they should print, plus the manual checks that no command covers.
- **Assumptions and defaults chosen** — every place you decided rather than asked, stated plainly so it can be corrected.

What to leave out: file-by-file or symbol-by-symbol inventories, restatements of the conversation, and speculative future work. A plan is a decision record, not a diff written in prose.

Prefer specifics over adjectives. "Add a `groundRules?: string[]` to the persisted state, normalized on read, dropped when empty" is a plan; "improve state handling" is a mood.

## Ending a turn, and ending the mode

Every planning turn ends in exactly one of two ways: a question, or `plan_mode_complete` called alone as the final action with the whole plan. Never end with prose announcing that a plan is coming — that costs a whole turn and produces nothing.

On revision, the next `plan_mode_complete` carries a **complete replacement**, not a delta. If you cannot write a complete replacement yet, keep planning and ask instead.

Once the plan is completed the user chooses what happens from the `/plan` menu: implement here, implement in a fresh session that reads the same file, export it, or discard it. The file is the source of truth from then on — it survives compaction, and the user may have hand-edited it, so re-read it before implementing rather than working from memory of what you wrote.

## When a plan is the wrong tool

Plan mode is for work whose *shape* is uncertain. It is overhead when it is not:

- **A single obvious change** — make it. A plan for a one-line fix costs more than the fix.
- **Pure investigation with no change in view** — investigate in the conversation. Plan mode blocks the tools that would let you experiment, and there is nothing to decide yet.
- **Work whose difficulty is execution, not design** ("run this migration on 40 hosts") → the interesting part is a runbook and a rollout order, not a design decision.

Say so in one line and offer the alternative rather than producing a plan nobody needed.
