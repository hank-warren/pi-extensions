import type { AutoPermissionsConfig } from "./config.js";
import { ALL_SHELL_GATE, findGates, type Gate } from "./gates.js";

/**
 * What the ruleset says about one command, before any guardian is involved.
 *
 * `pass` means nothing gated it: no rule matched, or the only rules that did
 * are ones this project trusts or has already granted an override for.
 */
export type CommandClassification =
  | { kind: "pass" }
  | { kind: "deny" | "convention" | "review"; gate: Gate };

/**
 * Rules that matched and still apply.
 *
 * Deny rules are hard policy boundaries: a project-scoped trusted-ops file
 * must not be able to lift one, or a checked-in file could disarm the
 * circuit breaker. Only guarded and convention matches honor the bypass.
 */
export function untrustedMatches(
  command: string,
  config: AutoPermissionsConfig,
  trustedGroups: ReadonlySet<string>,
): Gate[] {
  return findGates(command, config.rules).filter(
    (gate) => gate.level === "deny" || !trustedGroups.has(gate.group),
  );
}

/**
 * Decide a command's fate from the ruleset alone.
 *
 * Level priority across all matches, never first-match: a convention or
 * guarded rule earlier in config order must not shadow a deny rule later.
 */
export function classifyCommand(
  command: string,
  config: AutoPermissionsConfig,
  trustedGroups: ReadonlySet<string>,
  allowedConventionCommands: ReadonlySet<string>,
): CommandClassification {
  const ruleMatches = findGates(command, config.rules);
  const matches = ruleMatches.filter(
    (gate) => gate.level === "deny" || !trustedGroups.has(gate.group),
  );

  const deny = matches.find((gate) => gate.level === "deny");
  if (deny) return { kind: "deny", gate: deny };

  const convention = matches.find((gate) => gate.level === "convention");
  if (convention && !allowedConventionCommands.has(command)) {
    return { kind: "convention", gate: convention };
  }

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
