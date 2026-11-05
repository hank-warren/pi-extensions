/**
 * Read-only fast path for `reviewAllShell`: a command made only of known
 * read-only programs skips the blanket review, as Claude Code's built-in
 * read-only set skips its classifier.
 *
 * Conservative by construction. The command is tokenized with shell quoting,
 * and anything this parser cannot vouch for is "not read-only" and goes to the
 * guardian: substitutions (`$(`, backticks, `$VAR`), subshells and groups,
 * write redirects, here-docs, background jobs, env-prefixed commands, and any
 * program or subcommand not listed below. A false "not read-only" costs one
 * review; a false "read-only" runs a command unreviewed, so every doubt lands
 * on the review side.
 */

/** Programs that only read, whatever their arguments, except for the listed flags. */
const READ_ONLY_PROGRAMS: Record<string, RegExp | null> = {
  ls: null, pwd: null, cat: null, head: null, tail: null, wc: null, stat: null,
  realpath: null, basename: null, dirname: null, du: null, df: null, free: null, ps: null,
  id: null, whoami: null, uname: null, uptime: null, which: null, type: null,
  echo: null, printf: null, grep: null, egrep: null, fgrep: null, md5sum: null, sha1sum: null,
  sha256sum: null, sha512sum: null, cksum: null, jq: null, cut: null, tr: null, column: null,
  nl: null, diff: null, cmp: null, comm: null, strings: null, hexdump: null, od: null,
  base64: null, readlink: null, nproc: null, lscpu: null, lsblk: null, lsof: null, true: null,
  false: null, test: null, "[": null, sleep: null, cd: null,
  // tree -o writes its listing to a file.
  tree: /^(-o|--output(=|$))/,
  // ripgrep runs a preprocessor program with --pre.
  rg: /^--pre(=|$)/,
  // file -C compiles a magic file; ss -K kills sockets.
  file: /^(-\w*C|--compile)$/,
  ss: /^(-\w*K|--kill)$/,
  // sort -o writes a file; --compress-program runs one.
  sort: /^(-\w*o|--output(=|$)|--compress-program(=|$))/,
  // date -s sets the clock.
  date: /^(-\w*s|--set(=|$))/,
  find: /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/,
  journalctl: /^--(vacuum|rotate|flush|relinquish|smart-relinquish|setup-keys|sync|update-catalog)/,
};

/** Programs whose first non-flag argument is a subcommand; only these subcommands are read-only. */
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  docker: new Set(["ps", "images", "logs", "inspect", "version", "info"]),
  kubectl: new Set(["get", "describe", "logs", "top", "version", "explain"]),
  systemctl: new Set([
    "status", "show", "cat", "list-units", "list-timers", "list-unit-files", "list-sockets",
    "is-active", "is-enabled", "is-failed",
  ]),
  npm: new Set(["ls", "list", "view", "info", "outdated", "explain", "why"]),
};

const GIT_READ_ONLY = new Set([
  "status", "log", "show", "diff", "fetch", "blame", "describe", "rev-parse", "shortlog",
  "ls-files", "ls-remote", "ls-tree", "cat-file", "rev-list", "merge-base", "reflog",
  "grep", "for-each-ref", "show-ref", "name-rev", "cherry", "count-objects", "check-ignore",
]);
/** Flags that make an otherwise read-only git subcommand write or execute. */
const GIT_UNSAFE_ARG = /^(--output(=|$)|--upload-pack|--receive-pack|--exec(=|$)|--ext-diff|ext::|-c$|-O|--open-files-in-pager)/;
/** Flags of `git branch` that list, and the ones among them that take a value. */
const GIT_BRANCH_LIST_FLAG = /^(--list|--show-current|--all|--remotes|-[avr]+|--contains|--merged|--no-merged|--points-at)$/;
const GIT_BRANCH_VALUE_FLAG = /^--(contains|merged|no-merged|points-at)$/;

const GH_READ_ONLY: Record<string, Set<string>> = {
  pr: new Set(["view", "list", "diff", "status", "checks"]),
  run: new Set(["list", "view"]),
  issue: new Set(["view", "list", "status"]),
  repo: new Set(["view", "list"]),
  release: new Set(["list", "view"]),
  workflow: new Set(["list", "view"]),
  search: new Set(["repos", "issues", "prs", "code", "commits"]),
};
/** `gh api` is a GET unless one of these sets a method or a body. */
const GH_API_WRITE = /^(-X|--method(=|$)|-f|-F|--field(=|$)|--raw-field(=|$)|--input(=|$)|-X\w+)/;

type Token = { kind: "word"; text: string } | { kind: "op"; text: string };

/** Split shell text into words and control operators, or undefined when it holds anything unsafe. */
export function tokenizeShell(command: string): Token[] | undefined {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  const flush = () => {
    if (inWord) tokens.push({ kind: "word", text: word });
    word = "";
    inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j];
        // Any expansion inside double quotes is a value this parser cannot see.
        if (d === "$" || d === "`") return undefined;
        if (d === "\\") j++;
      }
      if (j >= command.length) return undefined;
      word += command.slice(i + 1, j).replace(/\\(.)/gu, "$1");
      inWord = true;
      i = j;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= command.length) return undefined;
      if (command[i + 1] !== "\n") word += command[i + 1];
      inWord = inWord || command[i + 1] !== "\n";
      i++;
      continue;
    }
    if (c === "$" || c === "`" || c === "(" || c === ")" || c === "{" || c === "}") return undefined;
    if (c === "#" && !inWord) {
      const end = command.indexOf("\n", i);
      i = end < 0 ? command.length : end - 1;
      continue;
    }
    if (c === " " || c === "\t") {
      flush();
      continue;
    }
    if (c === "\n" || c === ";") {
      flush();
      tokens.push({ kind: "op", text: ";" });
      continue;
    }
    if (c === "|") {
      flush();
      if (command[i + 1] === "|") {
        tokens.push({ kind: "op", text: "||" });
        i++;
      } else {
        tokens.push({ kind: "op", text: "|" });
      }
      continue;
    }
    if (c === "&" && command[i + 1] === "&") {
      flush();
      tokens.push({ kind: "op", text: "&&" });
      i++;
      continue;
    }
    if (c === "&" && command[i + 1] !== ">") return undefined; // a background job
    if (c === ">" || c === "<" || c === "&") {
      // A digit-only word glued to the operator is its fd (`2>/dev/null`), not an argument.
      if (inWord && /^\d+$/u.test(word) && /\d/u.test(command[i - 1] ?? "")) {
        word = "";
        inWord = false;
      } else {
        flush();
      }
      let j = i;
      while (j < command.length && "<>&".includes(command[j])) j++;
      const op = command.slice(i, j);
      // Here-docs, here-strings and process substitution carry content this parser does not read.
      if (op.includes("<<") || command[j] === "(") return undefined;
      if (op.endsWith("&")) {
        // fd duplication (`2>&1`, `>&2`, `<&0`) or closing (`>&-`) touches no file.
        let k = j;
        while (k < command.length && /[\d-]/u.test(command[k])) k++;
        if (k === j) return undefined;
        i = k - 1;
        continue;
      }
      while (command[j] === " " || command[j] === "\t") j++;
      let target = "";
      while (j < command.length && !/[\s;&|<>()]/u.test(command[j])) target += command[j++];
      if (!target || /[$`'"\\]/u.test(target)) return undefined;
      // Input redirects read; output redirects are allowed only into /dev/null.
      if (op !== "<" && target !== "/dev/null") return undefined;
      i = j - 1;
      continue;
    }
    word += c;
    inWord = true;
  }
  flush();
  return tokens;
}

function firstNonFlag(args: string[]): { value: string; index: number } | undefined {
  const index = args.findIndex((arg) => !arg.startsWith("-"));
  return index < 0 ? undefined : { value: args[index], index };
}

function gitSegmentReadOnly(args: string[]): boolean {
  let rest = args;
  // `git -C <dir>` and pager suppression are allowed; every other global option is not.
  for (;;) {
    if (rest[0] === "-C" && rest.length >= 2) rest = rest.slice(2);
    else if (rest[0] === "--no-pager" || rest[0] === "-P") rest = rest.slice(1);
    else break;
  }
  const [sub, ...subArgs] = rest;
  if (!sub || sub.startsWith("-")) return false;
  if (subArgs.some((arg) => GIT_UNSAFE_ARG.test(arg))) return false;
  if (GIT_READ_ONLY.has(sub)) return true;
  switch (sub) {
    case "branch":
      // A bare positional creates a branch; one is allowed only as a listing flag's value.
      return subArgs.every((arg, index) =>
        GIT_BRANCH_LIST_FLAG.test(arg) || (!arg.startsWith("-") && GIT_BRANCH_VALUE_FLAG.test(subArgs[index - 1] ?? "")));
    case "stash":
      return subArgs[0] === "list" || subArgs[0] === "show";
    case "worktree":
      return subArgs[0] === "list";
    case "remote":
      return subArgs.length === 0
        || (subArgs.length === 1 && (subArgs[0] === "-v" || subArgs[0] === "--verbose"))
        || subArgs[0] === "show" || subArgs[0] === "get-url";
    case "tag":
      return subArgs.length === 0 || subArgs[0] === "-l" || subArgs[0] === "--list";
    case "config":
      return /^(--get|--get-all|--get-regexp|--list|-l)$/u.test(subArgs[0] ?? "");
    default:
      return false;
  }
}

function ghSegmentReadOnly(args: string[]): boolean {
  const [area, action, ...rest] = args;
  if (area === "api") return !args.slice(1).some((arg) => GH_API_WRITE.test(arg));
  if (area === "auth") return action === "status";
  const actions = area ? GH_READ_ONLY[area] : undefined;
  return !!actions && !!action && actions.has(action) && !rest.includes("--web");
}

function segmentReadOnly(words: string[]): boolean {
  let [program, ...args] = words;
  if (!program) return false;
  // `timeout <duration> cmd` only bounds how long a read-only command runs.
  if (program === "timeout") {
    while (args[0]?.startsWith("-")) args = args.slice(1);
    if (!args[0] || !/^\d+(\.\d+)?[smhd]?$/u.test(args[0])) return false;
    return segmentReadOnly(args.slice(1));
  }
  // An env-prefixed command (`FOO=1 cmd`) can change what cmd executes.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(program)) return false;
  if (program === "git") return gitSegmentReadOnly(args);
  if (program === "gh") return ghSegmentReadOnly(args);
  if (program === "command") return args[0] === "-v" || args[0] === "-V";
  const subcommands = READ_ONLY_SUBCOMMANDS[program];
  if (subcommands) {
    const sub = firstNonFlag(args);
    if (!sub || !subcommands.has(sub.value)) return false;
    // A flag before the subcommand may take a value that looks like one (`kubectl -n get pods`).
    return sub.index === 0 || program === "systemctl";
  }
  if (!(program in READ_ONLY_PROGRAMS)) return false;
  const unsafe = READ_ONLY_PROGRAMS[program];
  return !unsafe || !args.some((arg) => unsafe.test(arg));
}

/** True when every command in `command` is a known read-only program with no unsafe arguments. */
export function isReadOnlyCommand(command: string): boolean {
  const tokens = tokenizeShell(command);
  if (!tokens) return false;
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (token.kind === "op") segments.push([]);
    else segments[segments.length - 1].push(token.text);
  }
  const commands = segments.filter((segment) => segment.length > 0);
  return commands.length > 0 && commands.every(segmentReadOnly);
}
