> Historical. Design spec for the initial pi-ask-user-question implementation; the repository's current conventions live in AGENTS.md.

# Spec: `@hank-warren/pi-ask-user-question`

Status: **draft / not yet implemented**
Owner: Hank
Replaces (on the host): `@juicesharp/rpiv-ask-user-question`

## 1. Why

`@juicesharp/rpiv-ask-user-question` (2.6.0) is ~4,800 LOC across 39 TypeScript
files plus 9 locale bundles. Most of that weight is a hand-rolled TUI layer —
preview pane, markdown cache, wrapping select, tab bar, key router, reducer +
selector modules — built on top of primitives `@earendil-works/pi-tui` already
exports (`SelectList`, `Markdown`, `Box`, `VStack`, `HStack`, `ScrollView`,
`Input`, `Text`, `matchesKey`, `decodeKittyPrintable`).

It is a good package. It is not a good *fit*, for two reasons:

1. **The selector is invisible to `pi-permission-selector`.** That extension
   patches pi's `ExtensionSelectorComponent` (behind `ctx.ui.select`). AUQ's TUI
   path uses `ctx.ui.custom()` with its own `view/components/wrapping-select.ts`,
   so digit hotkeys and Tab-to-comment silently do not apply — while AUQ's RPC
   fallback *does* use `ui.select`, so behavior differs by host.
2. **Weight we do not use.** 9 locales, an i18n bridge, an RPC dialog-walker for
   Zed/Paseo/VSCode-pendant hosts, and a hard `@juicesharp/rpiv-config`
   dependency — none of which apply to a terminal/Herdr-only host.

The goal is a **500–700 LOC** package with the same tool contract, the same
`!ctx.hasUI` lifecycle behavior, and one consistent selector implementation
across every dialog Pi shows.

## 2. Non-goals

- **No subagent escalation.** Children must *not* be able to interrupt the
  supervisor with questions. The tool is stripped when `!ctx.hasUI` (§7) and
  that is the whole story. Do not add a `subagent_supervisor` bridge.
- **No i18n.** English literals inline. No locale files, no bridge, no
  `t(key, fallback)` indirection.
- **No RPC / ACP dialog-walker.** Terminal hosts only. If `ctx.ui.custom()`
  returns `undefined`, return the "never saw the questions" error (§6.4) and let
  the model ask in plain chat.
- **No external-editor integration** for long custom answers (AUQ's
  `state/external-editor.ts`). A single-line `Input` is enough for v1.
- **Not a drop-in npm replacement for AUQ.** Different scope, different package
  name. Both register `ask_user_question`; only one may be installed.

## 3. LOC budget

Derived from the AUQ areas being replaced. Treat as a design constraint — if an
area blows its budget by 2x, stop and reconsider the design rather than shipping
it.

| Module | Budget | Replaces (AUQ LOC) |
|---|---:|---:|
| `tool/schema.ts` — typebox params + constants | 90 | `tool/types.ts` (129) |
| `tool/validate.ts` — reserved labels, bounds, preview rules | 90 | `tool/validate-questionnaire.ts` |
| `tool/envelope.ts` — LLM-facing result envelope | 80 | `tool/response-envelope.ts` + `format-answer.ts` (98+) |
| `questionnaire.ts` — session state, one mutable object | 120 | `state/*` (1,527) |
| `view/dialog.ts` — component tree, `ctx.ui.custom` factory | 130 | `view/*` (675) |
| `view/option-list.ts` — binds the shared selector (§9), multiselect | 110 | `view/components/*` (721) |
| `view/preview.ts` — `Markdown` in a `Box`, stacked layout | 60 | `view/components/preview/*` (712) |
| `events.ts` — public event contract | 50 | `events.ts` (55) |
| `reconcile.ts` — strip/restore on `hasUI` | 45 | `reconcile.ts` (47) |
| `config.ts` — local JSON config, no shared SDK | 50 | `config.ts` (75) + `rpiv-config` dep |
| `index.ts` — wiring | 40 | `index.ts` (54) |
| **Total** | **~865** | **~4,823** |

Budget lands above the 500–700 estimate because the estimate assumed inlining
validation and the envelope; keeping them as separately testable pure modules is
worth the ~150 lines. Dropped outright: i18n (115 + 40 KB JSON), RPC fallback
(166), selectors (180), external editor (62), submit picker / tab bar (122).

## 4. Package layout

```
packages/pi-ask-user-question/
  index.ts               # default export: registers tool + reconciler
  ask-user-question.ts   # tool registration, execute(), event emission
  reconcile.ts           # before_agent_start strip/restore on ctx.hasUI
  config.ts              # ~/.pi/... JSON config (guidance overrides, keys)
  events.ts              # public channel names + payload types
  questionnaire.ts       # session state machine (plain object, no reducer)
  tool/
    schema.ts
    validate.ts
    envelope.ts
  view/
    dialog.ts
    option-list.ts
    preview.ts
  test/
    validate.test.ts
    envelope.test.ts
    questionnaire.test.ts
    option-list.test.ts
    reconcile.test.ts
  README.md
  LICENSE                # MIT, copied from a sibling
  package.json
```

`package.json` per `AGENTS.md` §"Adding a Public Package": name
`@hank-warren/pi-ask-user-question`, version `0.1.0`, `"type": "module"`,
`"pi": { "extensions": ["./index.ts"] }`, `files` allowlist covering every
`*.ts` outside `test/` plus `README.md` and `LICENSE`.

`peerDependencies` (all `"*"`): `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`, `typebox`. **No `@earendil-works/pi-ai`** — no model
calls in this package.

`dependencies`: `@hank-warren/pi-permission-selector` for the shared selector
component (§9). Plain `dependencies` only — **never** `bundledDependencies`;
`AGENTS.md` §Structure documents why bundling is actively broken here.

## 5. Tool contract

Registered via `pi.registerTool({ name, label, description, promptSnippet,
promptGuidelines, parameters, execute })`. Tool name is **`ask_user_question`**,
verbatim, so session history from the AUQ era replays.

### 5.1 Parameters (typebox)

```ts
Option    = { label: string (non-empty), description: string, preview?: string }
Question  = { question: string, header: string (1..16),
              multiSelect?: boolean,
              options: Option[] (2..4, or 2..6 when multiSelect) }
Params    = { questions: Question[] (1..4) }
```

**Amended (multi-select ship, `pi-ask-user-question` 0.5.0).** The option cap is
mode-aware: 2..4 for a single-select question, 2..6 for a multi-select one.
Checkboxes are a shortlist UI rather than a pick-one UI, and six is where the
list stops fitting comfortably above the input dock — not where it stops being
a decision. The typebox `maxItems` is the looser of the two; `tool/validate.ts`
applies the mode-aware bound (§5.2).

### 5.2 Validation rules (`tool/validate.ts`, pure, unit-tested)

Reject the whole call with a structured error when:

| Rule | Error code |
|---|---|
| `questions.length` outside 1..4 | `bad_question_count` |
| `options.length` outside 2..4 | `bad_option_count` |
| `header.length > 16` | `header_too_long` |
| `label` empty or whitespace-only | `empty_label` |
| A label case-insensitively equals a reserved sentinel (`other`, `type something.`, `type something`) | `reserved_label` |
| Duplicate labels within one question | `duplicate_label` |

Rejection returns a tool error the model can act on, not a thrown exception.

**Amended (multi-select ship).** Two deviations from the table as originally
written:

- `bad_option_count` is mode-aware (2..4 single-select, 2..6 multi-select) and
  its message names the mode and its range, so the model can fix the call in
  one retry instead of guessing which bound it hit.
- **`preview_on_multiselect` is not implemented, and previews are allowed on
  multi-select questions.** The preview pane keys off the *highlighted* row,
  not the selected one, so it works unchanged when several rows are checked;
  there was nothing to forbid. Multi-select answers simply carry no `preview`
  into the envelope (§5.4).

**Amended (label cap dropped, issue #169).** `label_too_long` is gone and the
60-character cap with it. The renderer protects its own layout independently:
`pi-permission-selector/selector.ts` wraps label rows, and `view/dialog.ts`
clamps any line to the box's inner width as a last-resort invariant. A length
rule could therefore only ever discard a questionnaire that would have rendered
fine — the failure mode the model actually hit. Label length is now prose
guidance in the schema description ("aim for 1-5 words … no hard limit"), which
is pressure rather than a gate. **`empty_label` takes its place in the fatal
set**: a blank row genuinely cannot be rendered or picked. Checked per option
before the reserved and duplicate checks, and duplicate detection runs on labels
exactly as authored — with no truncation there is no clipped-prefix collision.
`header_too_long` stays fatal at 16: the chip is genuinely tight.

### 5.3 The custom-answer row

Every question gets an auto-appended **`Type something.`** row. It is not an
authored option — it is a sentinel appended at build time and stripped from the
answer. Selecting it opens an inline `Input` below the list; Enter commits the
typed text as the answer, Esc returns to the option list.

**Amended (multi-select ship).** On `multiSelect: true` questions the row is
also present, but typed text is **appended** to the checked labels rather than
replacing them. Checking it and pressing Enter opens the free-text field with
every other tick preserved; committing text records
`"pi-stats, pi-plan-mode, and also the docs site"` as one answer, with
`custom: true` meaning "a typed value is among the parts". Esc from the field
returns to the option list with the ticks intact.

Replacing the ticks was the original design and is worse: the user has just
expressed a selection, and a free-text row that silently discards it is a trap.
The sentinel counts toward neither option cap.

### 5.4 Result envelope (`tool/envelope.ts`)

Keep AUQ's proven shape — the model is already trained on it by prior sessions:

```
"User has answered your questions: "<question>"="<answer>". ... You can now
continue with the user's answers in mind."
```

- Multi-select answers join with `, ` in `answer`, and also appear as a
  `selected: string[]` field on the answer. `answer` stays a plain string, so
  `tool/envelope.ts` and every consumer of `details.answers` are unchanged.
- If the selected option carried a preview: append `selected preview: <text>`.
  **Amended (multi-select ship):** multi-select answers never carry a preview,
  even when checked options declare one — concatenating several previews into
  one answer string is noise the model authored itself.
- Cancelled (Esc), or zero answered questions → the single canonical string
  `User declined to answer questions`, with `details.cancelled = true`.

Return shape: `{ content: [{ type: "text", text }], details: QuestionnaireResult }`.

## 6. UI

### 6.1 Component tree

Built inside `ctx.ui.custom<QuestionnaireResult | null>((tui, theme, kb, done) => ...)`.

**Amended (in-flow dialog).** ~~`{ overlay: true }`~~ — the dialog is mounted in
the **editor area**, with no options argument at all. An overlay is composited
over the bottom rows of the viewport, so the transcript underneath it is
unreachable: the user is already scrolled to the bottom and there is nothing
left to scroll. The editor area is where `ctx.ui.select` renders and where
`pi-auto-permissions` already puts `OptionSelector`; in the normal document
flow the transcript is pushed up rather than covered, and every line stays
reachable in the terminal's own scrollback.

```
Box (bordered, title = "N of M · <header>")
└─ VStack
   ├─ Text        question text, wrapped
   ├─ SelectList  options + "Type something." sentinel   ← view/option-list.ts
   ├─ Input       inline custom answer (mounted on demand)
   └─ Text        key hints: "1-9 select · Tab comment · Enter confirm · Esc cancel"
```

Multi-question calls advance in place: answering question *i* re-binds the same
components to question *i+1*. **No tab bar** (AUQ's `tab-bar.ts` +
`tab-content-strategy.ts`, 306 LOC) — a linear "N of M" counter with
Left/Backspace to revisit the previous question covers the same ground.

### 6.2 Preview layout

When any option in the current question has `preview`, render it with pi-tui's
`Markdown` inside a `Box` **stacked below** the option list, height-capped at
half the overlay, in a `ScrollView`.

Deliberately not side-by-side. AUQ spent 712 LOC on `preview-layout-decider.ts`,
`markdown-content-cache.ts`, and the two block/box renderers largely to make a
two-column layout behave at narrow widths. Stacked needs none of it. Revisit
only if previews prove unreadable in practice.

### 6.3 Rendering rule: authored text wraps

**Everything the dialog displays renders in full. Wrapping is always better
than cutting off, and the box's per-line clamp is a backstop against an
unbreakable token — never a content policy.** Long labels wrap under their
ordinal at the row's continuation indent, and (since issue #169) so do option
descriptions, which previously ellipsed at the box edge. Two deliberate
exceptions:

- The **preview pane's row cap**, which is what stops a long preview pushing
  the options off screen, and which reports what it hid.
- A **description row clamp**, held in reserve. The worst case was measured
  live before shipping — four multi-select questions × six options, ~90-column
  labels and ~200-column descriptions, rendered in a 24-row pane — and the box
  overflowed the viewport but its top border, tab strip and question text
  stayed in the terminal's own scrollback, because the dialog renders in the
  editor area and pushes the transcript up rather than overlaying it. So no
  clamp shipped. Labels are never clamped either way: a runaway label makes a
  tall dialog, and that is the accepted cost.

### 6.4 Failure paths

| Condition | Behavior |
|---|---|
| `!ctx.hasUI` at execute time | Return `Error: UI not available (running in non-interactive mode)`, `details.error = "no_ui"`. Backstop only — §7 should have stripped the tool already. |
| `ctx.ui.custom()` resolves `undefined` | Return the explicit "the user never saw the questions — do NOT treat this as a decline; ask in plain chat instead" error, `details.error = "no_custom_ui"`. Wording matters: it stops the model from reading a host limitation as a refusal. |
| Esc | `cancelled: true` → decline envelope. |

## 7. Lifecycle: `!ctx.hasUI` strips the tool

**This is correct behavior and is being kept deliberately.** Subagent children
run headless; they must never be able to block waiting on a human, and they must
never route a question to the supervisor. Stripping the tool from the LLM's
active tool list is the mechanism.

`reconcile.ts`, on `before_agent_start`:

```ts
const active = pi.getActiveTools();
const has = active.includes(TOOL_NAME);
if (!ctx.hasUI && has)  pi.setActiveTools(active.filter(n => n !== TOOL_NAME));
if (ctx.hasUI  && !has) pi.setActiveTools([...active, TOOL_NAME]);
```

Idempotent; leaves sibling tools untouched. Unlike AUQ we do **not** carve out an
exception for `ctx.mode === "rpc"`, because there is no RPC fallback to justify
it (§2).

## 8. Events

Public contract, same stability policy as AUQ's (immutable channel names,
append-only payloads, JSON-safe values, new channel for breaking changes).
Emitted with `pi.events.emit(...)`.

```ts
export const ASK_USER_PROMPT_EVENT  = "hank:ask-user:prompt";
export const ASK_USER_BLOCKED_EVENT = "hank:ask-user:blocked";
```

- `prompt` — `{ questions: [{ question, header, multiSelect?, options: [{ label, description }] }] }`.
  Preview *content* is never shipped in the payload. `multiSelect` is emitted
  only when true — an append-only optional field under policy rule 2, so no new
  channel is needed.
- `blocked` — `{ active: boolean }`, cleared to `false` in a `finally` so
  listeners can distinguish blocked-on-human from working.

Consumers: `pi-statusline` (blocked indicator), `pi-auto-permissions` (suppress
guardian nags while a human is being asked).

## 9. Integration with `pi-permission-selector` — no monkey patch

### 9.1 The constraint that forces the design

pi exposes sanctioned override hooks for some UI surfaces — `setEditorComponent`,
`setFooter`, `setHeader`, `addAutocompleteProvider` — but **there is no
`setSelectorComponent`**. `ctx.ui.select(title, options: string[], opts)` takes
plain strings and pi renders the dialog internally.

So there are exactly two ways to get numbered options and Tab-to-comment into a
dialog:

1. Monkey-patch `ExtensionSelectorComponent` — global reach, but couples to
   pi-internal component shape (`updateList`, `handleInput`, `selectedIndex`,
   `listContainer`, `baseTitle`, `onSelectCallback`).
2. Do not call `ctx.ui.select` at all — render our own component through
   `ctx.ui.custom()`.

This package takes **(2)**, and that is the whole point of the exercise: no
goofy wiring, no patching, the behavior comes from a component we own and
compose explicitly.

### 9.2 Decision: `pi-permission-selector` owns the shared component

`pi-permission-selector` is repurposed from *global enhancer* to *shared
component provider*. It gains an exported, reusable selector; consumers depend
on the **published npm package** and import it — the
`pi-herdr-auto-title` → `pi-auto-permissions` precedent (plain `dependencies`,
**never** `bundledDependencies`; see `AGENTS.md` §Structure). This satisfies the
ban on cross-package *source* imports.

```
packages/pi-permission-selector/
  selector.ts        # NEW - exported component: digits, Tab-to-comment
  keys.ts            # NEW - isTabKey/isEscapeKey/isEnterKey/isBackspaceKey, digit decode
  selector-patch.ts  # unchanged for now (see 9.4; since deleted when 9.4 was executed)
  index.ts           # unchanged for now (since deleted when 9.4 was executed)

pi-ask-user-question --dependencies--> @hank-warren/pi-permission-selector
pi-auto-permissions  --dependencies--> (deferred, see 9.4)
```

The exported surface (`selector.ts`, `keys.ts`) becomes a frozen contract:
add both to the `files` allowlist, and add a contract test mirroring
`packages/pi-herdr-auto-title/test/guardian-transport-contract.test.ts`.

### 9.3 Accepted trade-off: our dialogs only

The monkey patch numbers **every** extension select dialog, including pi's own
(model picker, theme, session tree) and any third-party extension's. Explicit
composition cannot reach those.

**This loss is accepted.** Numbered options and Tab-to-comment will apply to
`pi-auto-permissions` and `pi-ask-user-question` dialogs; everything else
reverts to stock arrows/Enter. In exchange, nothing in our packages breaks when
a pi upgrade changes selector internals.

Upstreaming a `setSelectorComponent` hook to `earendil-works/pi` would restore
global reach cleanly and is worth filing — but it is out of our hands and does
not gate any version here.

### 9.4 Deferred: removing the patch

> **Status: executed.** Both call sites now compose `OptionSelector` through
> `ctx.ui.custom()`, `selector-patch.ts` and `index.ts` are deleted, and
> `pi-permission-selector` is a pure library with no `pi.extensions` entry.

Out of scope for v0.1. `pi-auto-permissions` keeps calling `ctx.ui.select` at
`index.ts:698` and `index.ts:882`, and `selector-patch.ts` stays live, until the
shared component has proven itself in this package's dialog.

Follow-up change, once v0.1 has run as a daily driver:

1. Migrate both `ctx.ui.select` call sites in `pi-auto-permissions` to the
   shared component via `ctx.ui.custom()`, preserving the `signal` /
   cancellation semantics that the approval flow depends on.
2. Delete `selector-patch.ts` and the `applyPatch` call in
   `pi-permission-selector/index.ts`; the extension's default export becomes a
   no-op (or the package drops its `pi.extensions` entry entirely and becomes a
   pure library).
3. Major-version changeset for `pi-permission-selector` — standalone installs
   lose all current behavior.

Sequencing rationale: `pi-auto-permissions` gates real Bash execution. Putting
an unproven `ctx.ui.custom()` path in front of it on day one is the one way this
refactor could actually hurt.

### 9.5 Comment delivery

Tab-to-comment delivers the typed note exactly as `pi-permission-selector` does
today — `pi.sendUserMessage(comment, { deliverAs: "steer" })`, wrapped so a
delivery failure can never break the dialog. The component takes this as an
`onComment` hook rather than reaching for `pi` itself, so it stays a pure
component and the host package owns message delivery.

## 10. Config

Local JSON at the pi config path, loaded per-call, no shared SDK:

```jsonc
{
  "guidance": { "promptSnippet": "...", "promptGuidelines": "..." },
  "digitHotkeys": true            // default true; false = arrows/Enter only
}
```

Invalid or missing → documented defaults. No `/reload` requirement: read fresh.

## 11. Testing

Node's built-in runner, `node --import tsx --test`, matching sibling packages.

| File | Covers |
|---|---|
| `validate.test.ts` | every §5.2 rule, both directions |
| `envelope.test.ts` | single/multi answers, preview suffix, notes suffix, cancelled, zero-answers → decline |
| `questionnaire.test.ts` | advance/revisit, sentinel append + strip, multiselect toggling, custom-answer override |
| `option-list.test.ts` | digit hotkeys incl. >9 options guard, Tab→input transition, Esc unwinds input before dialog |
| `reconcile.test.ts` | strip when `!hasUI`, restore when `hasUI`, idempotent, siblings untouched |

View rendering is not snapshot-tested; keep `view/` thin enough that the logic
worth testing lives in `questionnaire.ts` and `option-list.ts`.

## 12. Registration checklist

Every one of these is enforced by `scripts/validate.py` or `smoke-load.mjs` and
will fail `npm test` if skipped:

1. `PUBLIC_PACKAGES` in `scripts/validate.py`
2. `EXPECTED_EXTENSION_ENTRYPOINTS` in `scripts/validate.py`
3. `pi.extensions` in the root `package.json` (must match #2 exactly)
4. Root script `"test:ask-user-question": "node --import tsx --test packages/pi-ask-user-question/test/*.test.ts"`, called from `scripts/test.sh`
5. `EXPECTED_SURFACES` in `scripts/smoke-load.mjs` — exact-set comparison, so the new tool name must be listed
6. `npm install --package-lock-only` — otherwise `npm ci` fails the publish with `Missing: @hank-warren/pi-ask-user-question from lock file`
7. Public-packages table in the root `README.md`
8. A changeset (`npx changeset`) committed alongside

Verify: `npm test`, `npm run typecheck`, `npm run scan-secrets`,
`npm pack --dry-run` inside the package, and
`pi -ne -e ./packages/pi-ask-user-question --list-models` loading standalone with
zero diagnostics.

## 13. Migration

`@juicesharp/rpiv-ask-user-question` must be uninstalled from the host before
this loads — two extensions registering `ask_user_question` collide. Session
history replays cleanly because the tool name and the result-envelope shape are
preserved (§5, §5.4).

## 14. Phasing

- **v0.1 — walking skeleton.** Single question, options + digit hotkeys +
  `Type something.`, Esc cancel, envelope, `reconcile.ts`, events. No preview,
  no multi-select, no multi-question. Prove `ctx.ui.custom()` + `SelectList` +
  the key path end to end.
- **v0.2 — full contract.** Multi-question (N of M, Left to revisit),
  `multiSelect`, stacked preview pane.
  - Multi-question and the stacked preview pane shipped in 0.3.x.
  - **`multiSelect` shipped in 0.5.0**, as an opt-in mode on
    `pi-permission-selector`'s `OptionSelector` rather than in the dialog: the
    dialog already delegates every row-rendering, wrapping, numbering and note
    concern to that component. Two deliberate deviations from this spec, both
    amended in place above: previews are **allowed** on multi-select questions
    (§5.2 — the pane keys off the highlighted row, so there was nothing to
    forbid), and typed text from the `Type something.` row is **appended** to
    the checked labels rather than replacing them (§5.3 — discarding a
    selection the user just made is a trap).
- **v0.3 — polish.** Tab-to-comment parity with `pi-permission-selector`,
  config-driven hotkey toggle, README with screenshots.

Ship v0.1 and run it as the daily driver before writing v0.2. If `ctx.ui.custom()`
turns out to be more hostile than AUQ's code suggests, that is the cheapest
possible place to find out.
