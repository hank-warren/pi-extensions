/**
 * Bounding the revise path for an unattended loop.
 *
 * Turning "ask_user" into a readable block removes the deadlock, but on its
 * own it replaces one failure with a worse one: an agent that can always try
 * again will always try again, and "keep adjusting the command until the
 * guardian stops objecting" is a search for the phrasing that slips past the
 * gate. That is precisely what pi-loop's own autonomy posture forbids, and it
 * is not made safe by the guardian re-reviewing each attempt — the guardian
 * reviews commands, and the thing being optimised against it is the command.
 *
 * So the rounds are counted, per concern, and they run out. Within the bound
 * the agent may revise to *address* what the guardian said. Past it the block
 * stops offering that option and names `loop_wait` instead, which is the only
 * way a loop can ask a human anything without deadlocking itself.
 *
 * The count is keyed on the concern rather than the command precisely because
 * the command is what changes: counting per command would reset the budget on
 * every reshape, which is the behaviour being bounded.
 *
 * Two bounds, not one, and this is the load-bearing detail. A per-concern
 * count is what makes the block specific enough to act on ("one round remains
 * against *this*"), but a concern is prose and prose gets reworded, so a
 * guardian phrasing the same objection differently would hand back a fresh
 * budget — the failure mode this exists to prevent, arriving through the back
 * door. The per-gate count is immune to wording and bounds the whole argument
 * regardless. Whichever runs out first ends it.
 */

const LOOP_REVISIONS_ENTRY_TYPE = "auto-permissions-loop-revisions";

/**
 * How many revisions an agent gets against one concern before it must wait.
 *
 * Three blocked attempts, so there are two real revisions: the first is often
 * an honest misunderstanding of a terse concern and the second is the
 * considered fix. A third attempt at the same objection is not a better
 * command, it is a search.
 */
export const LOOP_REVISE_ROUNDS = 3;

/**
 * How many blocked attempts an agent gets at one gate before it must wait,
 * whatever the concerns were.
 *
 * Deliberately larger than the per-concern bound: a second, genuinely
 * different objection deserves its own rounds. Deliberately finite: an agent
 * collecting objection after objection at the same gate is not converging on
 * an authorized command, and the wording of the objection is not what makes
 * that true.
 */
export const LOOP_GATE_ROUNDS = 5;

/**
 * How many times in a row an agent may be blocked, at any gate, for any
 * concern, before it must wait.
 *
 * The backstop, and the only bound nothing can reshape its way out of. Both
 * bounds above are keyed on something the *command* determines: the concern is
 * the guardian's prose, and the gate is whichever rule the command text
 * matched. A canary walked straight through both — blocked on
 * `git branch -D`, the agent tried `git branch --delete`, which is the same
 * operation under a different rule, and the budget started over.
 *
 * Counting blocks is immune to both, because it measures the argument rather
 * than the command. Only resolving that argument — an approval at a gate that
 * has been blocking — resets it.
 */
export const LOOP_STREAK_ROUNDS = 5;

/** Words too common to distinguish one guardian concern from another. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from", "has", "have",
  "in", "is", "it", "its", "not", "of", "on", "or", "that", "the", "this", "to", "was", "were",
  "which", "with", "would", "user", "command", "action", "request", "because", "without",
]);

/** Cap on the tokens that form a concern's signature. */
const SIGNATURE_TOKENS = 10;

/**
 * A stable key for "the same objection, restated".
 *
 * A guardian writes one concise sentence and writes it slightly differently
 * each time, so exact text would reset the budget on every round. The sorted
 * set of significant words survives rewording, and when two genuinely
 * different concerns do collide the budget only ever binds *tighter* — the
 * safe direction for a bound whose failure mode is unbounded retrying.
 */
export function concernKey(gateLabel: string, reason: string): string {
  const tokens = [
    ...new Set(
      reason
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .map(stem)
        .filter((token) => token.length > 2 && !STOPWORDS.has(token)),
    ),
  ]
    .sort()
    .slice(0, SIGNATURE_TOKENS);
  return `${gateLabel}::${tokens.join(" ")}`;
}

/**
 * Crude suffix stripping, so "authorize", "authorized" and "authorizing" are
 * one token. Not linguistics: just enough that the commonest rewording of the
 * same objection lands on the same key. Anything it misses is caught by the
 * per-gate bound, which is why it can afford to be crude.
 */
function stem(token: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (token.length > suffix.length + 3 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

interface PersistedBudget {
  concerns?: unknown;
  gates?: unknown;
  streak?: unknown;
}

/**
 * Per-concern revision counts for this session.
 *
 * Held in memory *and* persisted as a custom session entry. The memory copy is
 * what survives a context compaction (the process does not restart, so the map
 * is untouched while the conversation around it is rewritten); the persisted
 * copy is what survives a session restore, and what makes the bound
 * reconstructible rather than merely lucky. Both matter: a bound that a
 * compaction silently reset would hand the agent unlimited rounds at exactly
 * the moment its own memory of the concern was summarised away.
 */
/** What one charged round leaves the agent with. */
export interface LoopReviseCharge {
  /** Rounds spent against this concern, including the one being reported. */
  concernSpent: number;
  /** Blocked attempts at this gate, including the one being reported. */
  gateSpent: number;
  /** Consecutive blocked attempts anywhere, including the one being reported. */
  streakSpent: number;
  /**
   * Whether `concernSpent` was inherited from the streak rather than earned
   * against this concern — i.e. the objection is being stated for the first
   * time, mid-argument.
   *
   * The inheritance is what makes the bound un-reshapable (see `charge`), and
   * it is exactly what makes the *sentence* around the number wrong if nothing
   * carries this fact: a first-ever objection would be described as one the
   * agent has been arguing with. A canary drove three single, un-revised
   * commands at three different gates and was told it had "used every revision
   * round this loop gets against it" and should "stop reshaping the command".
   * It had reshaped nothing. The bound was right; the wording was not.
   */
  concernInherited: boolean;
}

export class LoopReviseBudget {
  private concerns = new Map<string, number>();
  private gates = new Map<string, number>();
  private streak = 0;

  /** Rebuild from a session branch, fail-open: unreadable state means no rounds spent. */
  restore(entries: readonly unknown[]): void {
    this.concerns = new Map();
    this.gates = new Map();
    this.streak = 0;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index] as
        | { type?: string; customType?: string; data?: unknown }
        | undefined;
      if (entry?.type !== "custom" || entry.customType !== LOOP_REVISIONS_ENTRY_TYPE) continue;
      const data = entry.data as PersistedBudget | undefined;
      readCounts(data?.concerns, this.concerns);
      readCounts(data?.gates, this.gates);
      const streak = data?.streak;
      if (typeof streak === "number" && Number.isSafeInteger(streak) && streak > 0) {
        this.streak = streak;
      }
      return;
    }
  }

  /** The whole budget, as the data half of a session entry. */
  snapshot(): {
    concerns: Record<string, number>;
    gates: Record<string, number>;
    streak: number;
  } {
    return {
      concerns: Object.fromEntries(this.concerns),
      gates: Object.fromEntries(this.gates),
      streak: this.streak,
    };
  }

  /** The custom-entry type this budget persists under. */
  static get entryType(): string {
    return LOOP_REVISIONS_ENTRY_TYPE;
  }

  /** What `charge` would report without charging. */
  spent(gateLabel: string, reason: string): LoopReviseCharge {
    return {
      concernSpent: this.concerns.get(concernKey(gateLabel, reason)) ?? 0,
      gateSpent: this.gates.get(gateLabel) ?? 0,
      streakSpent: this.streak,
      concernInherited: false,
    };
  }

  /**
   * Charge one blocked attempt and return the new totals.
   *
   * A concern seen for the first time *during an argument already under way at
   * this gate* inherits that argument's length rather than starting at one.
   * Without it the count silently stops advancing whenever the guardian
   * rewords its objection, and the block repeats "1 revision round remains"
   * forever. Observed live in a canary, where the agent read two identical
   * blocks and said so: "it says again '1 revision round remains' —
   * ambiguous". A budget whose displayed remainder does not fall is not a
   * budget, and the agent is right not to trust it.
   */
  charge(gateLabel: string, reason: string): LoopReviseCharge {
    const key = concernKey(gateLabel, reason);
    this.streak += 1;
    const gateSpent = (this.gates.get(gateLabel) ?? 0) + 1;
    const seen = this.concerns.get(key);
    // A concern or a gate first seen mid-argument inherits the argument's
    // length from the streak, which is the only count a reshape cannot move.
    const concernSpent = seen === undefined ? this.streak : seen + 1;
    this.concerns.set(key, concernSpent);
    this.gates.set(gateLabel, gateSpent);
    // Inherited only when the streak actually supplied something: the first
    // block of a loop is a concern's own first round, not a borrowed count.
    return {
      concernSpent,
      gateSpent,
      streakSpent: this.streak,
      concernInherited: seen === undefined && this.streak > 1,
    };
  }

  /**
   * An approved command ends the argument at that gate.
   *
   * Without this a long loop would accumulate unrelated objections all session
   * and eventually refuse to revise anything. The per-concern counts stay:
   * approving one command is not an answer to a different objection.
   *
   * The streak resets only when the approval lands on a gate that was actually
   * blocking. Resetting it on *any* approval looked reasonable and was not: a
   * canary agent ran three read-only `git log` and `git merge-base` calls
   * between two blocked deletions, each approved, and every one of them handed
   * the budget back. The backstop has to survive an agent looking things up in
   * the middle of an argument, which is exactly what a thoughtful agent does.
   */
  settle(gateLabel: string): void {
    if (this.gates.delete(gateLabel)) this.streak = 0;
  }

  /** Forget everything: a new loop is not answerable for the last one's rounds. */
  clear(): void {
    this.concerns = new Map();
    this.gates = new Map();
    this.streak = 0;
  }
}

function readCounts(value: unknown, into: Map<string, number>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) continue;
    if (!key || key.length > 512) continue;
    into.set(key, count);
  }
}

interface LoopBlockOptions extends LoopReviseCharge {
  gateLabel: string;
  reason: string;
  /**
   * The verdict being delivered. Both non-approving verdicts arrive here, and
   * they do not mean the same thing: `ask_user` is "a human would have to
   * authorize this", `revise` is "the operation is authorized, this command
   * is not". Announcing the second as the first tells an unattended agent to
   * go and find a human when the reviewer asked it for an edit.
   */
  decision?: "ask_user" | "revise";
  maxRounds?: number;
  maxGateRounds?: number;
  maxStreakRounds?: number;
}

/**
 * The block an unattended loop receives instead of a modal.
 *
 * Within the bound it is an invitation to address the concern; past it, it is
 * not. The final block deliberately offers exactly one next action, because a
 * block that merely says "no" leaves the agent to invent its own way forward,
 * and inventing a way forward past a permission gate is the failure mode.
 */
export function loopBlockReason(options: LoopBlockOptions): string {
  const maxRounds = options.maxRounds ?? LOOP_REVISE_ROUNDS;
  const maxGateRounds = options.maxGateRounds ?? LOOP_GATE_ROUNDS;
  const head = options.decision === "revise"
    ? `${options.gateLabel} was not approved as written, and this session is running an unattended /loop, so the reviewer's revision request comes back here instead of a prompt: ${options.reason}`
    : `${options.gateLabel} needs user approval, and this session is running an unattended /loop, so there is no one to ask: ${options.reason}`;
  // One number, and it is the binding one. Reporting the per-concern budget
  // alone let a reworded objection hold it still; reporting the per-gate one
  // alone would promise rounds the concern budget will not honour.
  const remaining = Math.min(
    maxRounds - options.concernSpent,
    maxGateRounds - options.gateSpent,
    (options.maxStreakRounds ?? LOOP_STREAK_ROUNDS) - options.streakSpent,
  );
  // Whose budget the number is. A count inherited from the streak is not this
  // objection's history, and saying that it is invites the agent to distrust a
  // number that is in fact correct — or, at the end, to be told to stop doing
  // something it never did.
  const loopBound = options.concernInherited;
  const wait = "Call loop_wait naming this concern, and record the options in the ledger so a human can answer in one word. If the objective can be advanced another way that does not involve this operation, do that instead.";
  if (remaining <= 0) {
    return [
      head,
      loopBound
        ? `This objection is new, so no revision rounds were spent against it — what ran out is the loop's budget for consecutive blocked commands: ${options.streakSpent} gated ${plural(options.streakSpent, "command")} in a row, with no approval in between. Further gated commands will not be approved either, and searching for one that is would be an end run around the gate.`
        : `You have used every revision round this loop gets against it. Stop reshaping the command — further variations of it will not be approved, and searching for one that is would be an end run around the gate.`,
      wait,
    ].join("\n");
  }
  const budget = `${remaining} revision ${plural(remaining, "round")} ${remaining === 1 ? "remains" : "remain"}`;
  return [
    head,
    loopBound
      ? `You may revise the command to address that specific concern. This objection is new, so the number that follows is the loop's rather than this concern's: ${options.streakSpent} gated ${plural(options.streakSpent, "command")} in a row have been blocked with no approval in between, and ${budget} before you must call loop_wait rather than trying further gated commands.`
      : `You may revise the command to address that specific concern. ${budget}; after that you must call loop_wait rather than reshaping further.`,
    "Revise only to satisfy the concern as stated. Do not split, obfuscate, or re-route the command to avoid the gate — that is an end run, not a revision.",
  ].join("\n");
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
