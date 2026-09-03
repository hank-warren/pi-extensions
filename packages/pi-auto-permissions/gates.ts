/**
 * Rule severity levels, in decision order:
 * - `deny`: blocks immediately with the rule's required `message`. A hard
 *   policy boundary — not clearable by `request_override`, not bypassed by
 *   `.pi/trusted-ops` groups, never shown to the guardian. The mechanical
 *   analogue of Claude Code's pre-classifier circuit breaker.
 * - `convention`: blocks directly with the rule's required `message`, but the
 *   agent may ask the user for a one-session exception via `request_override`.
 * - `guarded`: sends the command to the guardian reviewer.
 *
 * When several rules match one command, the effective level is the most
 * severe across *all* matches (deny > convention > guarded), never the first
 * match in config order.
 */
export type GateLevel = "deny" | "guarded" | "convention";

export interface Gate {
  pattern: RegExp;
  level: GateLevel;
  group: string;
  label: string;
  message?: string;
  suggest?: (command: string) => string;
}

/**
 * The fallback gate used when `reviewAllShell` is enabled and a bash command
 * matches no configured rule: everything the ruleset does not name is still
 * reviewed under this generic gate (the analogue of Claude Code's
 * `classifyAllShell`). Its group participates in `.pi/trusted-ops` like any
 * other, so a trusted project can opt back out of blanket review.
 */
export const ALL_SHELL_GATE: Gate = {
  pattern: /(?:)/,
  level: "guarded",
  group: "all-shell",
  label: "shell command",
};

export function findGates(command: string, rules: readonly Gate[]): Gate[] {
  return rules.filter((gate) => {
    gate.pattern.lastIndex = 0;
    return gate.pattern.test(command);
  });
}

export function findGate(command: string, rules: readonly Gate[]): Gate | undefined {
  return findGates(command, rules)[0];
}
