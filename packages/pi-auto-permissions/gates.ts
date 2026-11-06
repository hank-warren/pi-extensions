/**
 * Rule severity levels, in decision order:
 * - `deny`: blocks immediately with the rule's required `message`. A hard
 *   policy boundary — not bypassed by `.pi/trusted-ops` groups, never shown
 *   to the guardian. The mechanical analogue of Claude Code's pre-classifier
 *   circuit breaker.
 * - `guarded`: sends the command to the guardian reviewer.
 *
 * When several rules match one command, the effective level is the most
 * severe across *all* matches (deny > guarded), never the first match in
 * config order.
 */
export type GateLevel = "deny" | "guarded";

export interface Gate {
  pattern: RegExp;
  level: GateLevel;
  group: string;
  label: string;
  message?: string;
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

const UNMODELLED_SHELL = /\$\(|`|[<>]\(|<<|\$\{(?![A-Za-z_]\w*\})/;

/**
 * Rewrite a command so that a newline remains only where the shell ends a command.
 * Rules stop at a newline, so this is what keeps them inside one command:
 * - an unescaped backslash-newline is a line continuation and is removed
 *   (`rm -rf \⏎/usr` is `rm -rf /usr`), outside quotes and inside "…" or $'…';
 * - a newline inside quotes is part of an argument and becomes a space
 *   (`git commit -m 'a⏎⏎b' --amend` stays one command);
 * - a `#` comment is inert, so a quote character in it changes nothing.
 * An unterminated quote keeps joining to the end, which only matches more. A
 * command using what this scan does not model (command or process substitution,
 * backticks, heredocs, `${…}` beyond a plain name), where quotes nest or lines
 * are data, keeps no newline at all: the whole command is one line, as before
 * rules stopped at newlines.
 */
export function normalizeCommandLines(command: string): string {
  if (UNMODELLED_SHELL.test(command)) return command.replace(/\\\r?\n/g, "").replace(/\r?\n/g, " ");
  let out = "";
  let quote: "'" | "\"" | "$'" | "#" | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    const newline = char === "\n" ? 1 : char === "\r" && command[index + 1] === "\n" ? 2 : 0;
    if (newline > 0) {
      if (quote === "#") quote = undefined;
      out += quote ? " " : "\n";
      index += newline - 1;
      continue;
    }
    if (quote === "#") {
      out += char;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      const next = command[index + 1];
      if (next === "\n") {
        index += 1;
        continue;
      }
      if (next === "\r" && command[index + 2] === "\n") {
        index += 2;
        continue;
      }
      out += next === undefined ? char : char + next;
      index += 1;
      continue;
    }
    if (quote) {
      if ((quote === "\"" && char === "\"") || (quote !== "\"" && char === "'")) quote = undefined;
      out += char;
      continue;
    }
    if (char === "'") quote = out.endsWith("$") ? "$'" : "'";
    else if (char === "\"") quote = "\"";
    else if (char === "#" && (out.length === 0 || /[\s;&|()]$/.test(out))) quote = "#";
    out += char;
  }
  return out;
}

export function findGates(command: string, rules: readonly Gate[]): Gate[] {
  const joined = normalizeCommandLines(command);
  return rules.filter((gate) => {
    gate.pattern.lastIndex = 0;
    return gate.pattern.test(joined);
  });
}
