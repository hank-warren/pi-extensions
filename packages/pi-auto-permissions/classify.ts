import type { AutoPermissionsConfig } from "./config.js";
import { ALL_SHELL_GATE, findGates, type Gate } from "./gates.js";

/**
 * What the ruleset says about one command, before any guardian is involved.
 *
 * `pass` means nothing gated it: no rule matched, or the only rules that did
 * are ones this project trusts.
 */
export type CommandClassification =
  | { kind: "pass" }
  | { kind: "deny" | "review"; gate: Gate };

/**
 * Decide a command's fate from the ruleset alone.
 *
 * Level priority across all matches, never first-match: a guarded rule
 * earlier in config order must not shadow a deny rule later.
 *
 * Deny rules are hard policy boundaries: a project-scoped trusted-ops file
 * must not be able to lift one, or a checked-in file could disarm the
 * circuit breaker. Only guarded matches honor the bypass.
 */
export function classifyCommand(
  command: string,
  config: AutoPermissionsConfig,
  trustedGroups: ReadonlySet<string>,
): CommandClassification {
  const ruleMatches = findGates(command, config.rules);
  const matches = ruleMatches.filter(
    (gate) => gate.level === "deny" || !trustedGroups.has(gate.group),
  );

  const deny = matches.find((gate) => gate.level === "deny");
  if (deny) return { kind: "deny", gate: deny };

  let gate = matches.find((candidate) => candidate.level === "guarded");
  // With reviewAllShell on, a command no rule names at all still gets a
  // guardian review under the generic gate. "No rule" is judged before the
  // trusted-groups filter: a command whose matching group the project
  // trusts was explicitly waved through, not left unnamed, and must not be
  // re-captured by the blanket gate.
  if (!gate && !ruleMatches.length && config.reviewAllShell && !trustedGroups.has(ALL_SHELL_GATE.group)) {
    gate = ALL_SHELL_GATE;
  }
  return gate ? { kind: "review", gate } : { kind: "pass" };
}
