/**
 * Read-only fast path for `reviewAllShell`: a command made only of known
 * read-only programs skips the blanket review, as Claude Code's built-in
 * read-only set skips its classifier.
 *
 * An allowlist all the way down. A program is read-only here only when no
 * argument can make it write, execute, or reveal a credential (PURE), or when
 * every flag it is given is one this file lists (`rg`, `git`, `gh`). Anything
 * this parser cannot vouch for — an unknown program, subcommand or flag, a
 * substitution or expansion, a subshell, a here-doc, a background job, an
 * env-prefixed command, a write redirect other than to /dev/null — goes to the
 * guardian. A forgotten safe flag costs one review; a forgotten unsafe one
 * would run a command unreviewed, which is why no list here names unsafe flags.
 */

/** Programs no argument can make write, execute, or print a credential. */
const PURE = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "stat", "realpath", "basename", "dirname", "du", "df",
  "free", "ps", "id", "whoami", "uname", "uptime", "which", "type", "echo", "printf", "grep",
  "egrep", "fgrep", "md5sum", "sha1sum", "sha256sum", "sha512sum", "cksum", "cut", "tr",
  "column", "nl", "diff", "cmp", "comm", "strings", "hexdump", "od", "base64", "readlink",
  "nproc", "lscpu", "lsblk", "lsof", "true", "false", "test", "[", "sleep", "cd",
]);

/** The flags a program may be given. Anything else is not read-only. */
interface FlagSpec {
  /** Boolean short flags, combinable (`-niw`). */
  short?: string;
  /** Short flags taking the next argument, or the rest of this one (`-e PAT`, `-A3`). */
  shortValue?: string;
  /** Short flags taking an attached value only (`-M50%`); never the next argument. */
  shortAttached?: string;
  /** Boolean long flags. */
  long?: readonly string[];
  /** Long flags taking `=value` or the next argument. */
  longValue?: readonly string[];
  /** Long flags taking an optional attached `=value` only; never the next argument. */
  longOptional?: readonly string[];
  /** Accept `-<number>` (`git log -5`). */
  numeric?: boolean;
}

/** The positional arguments when every flag fits `spec`, or undefined when one does not. */
export function positionalsIfAllowed(args: readonly string[], spec: FlagSpec): string[] | undefined {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq < 0 ? arg : arg.slice(0, eq);
      if (spec.longValue?.includes(name)) {
        if (eq < 0) i++;
        continue;
      }
      if (spec.longOptional?.includes(name)) continue;
      if (eq < 0 && spec.long?.includes(name)) continue;
      return undefined;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (spec.numeric && /^-\d+$/u.test(arg)) continue;
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (spec.shortValue?.includes(flag)) {
          if (j === arg.length - 1) i++;
          break;
        }
        if (spec.shortAttached?.includes(flag)) break;
        if (!spec.short?.includes(flag)) return undefined;
      }
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
}

const RG: FlagSpec = {
  short: "nilcwvFSuLHNoxsUPqIa",
  shortValue: "egtTABCmjMfEdr",
  long: [
    "--hidden", "--no-ignore", "--no-ignore-vcs", "--no-ignore-dot", "--no-ignore-parent", "--files",
    "--files-with-matches", "--files-without-match", "--count", "--count-matches", "--line-number",
    "--no-line-number", "--ignore-case", "--smart-case", "--case-sensitive", "--word-regexp",
    "--line-regexp", "--fixed-strings", "--invert-match", "--json", "--vimgrep", "--only-matching",
    "--multiline", "--multiline-dotall", "--pcre2", "--no-heading", "--heading", "--with-filename",
    "--no-filename", "--follow", "--trim", "--stats", "--unrestricted", "--text", "--null",
    "--null-data", "--column", "--byte-offset", "--passthru", "--quiet", "--no-messages",
    "--type-list", "--one-file-system", "--no-config", "--max-columns-preview", "--binary",
    "--crlf", "--no-unicode", "--glob-case-insensitive", "--include-zero", "--sort-files",
  ],
  longValue: [
    "--regexp", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--context", "--after-context",
    "--before-context", "--max-count", "--max-depth", "--max-filesize", "--max-columns", "--sort",
    "--sortr", "--threads", "--replace", "--file", "--encoding", "--engine", "--color", "--colors",
    "--context-separator", "--field-match-separator", "--field-context-separator",
    "--path-separator",
  ],
};

/** Flags shared by git's history and diff readers (log, show, diff, rev-list, shortlog, stash show). */
const GIT_HISTORY: FlagSpec = {
  short: "puswbaiEFPzRrtc",
  shortValue: "nSG",
  shortAttached: "UMCB",
  numeric: true,
  long: [
    "--oneline", "--shortstat", "--numstat", "--summary", "--name-only", "--name-status", "--raw",
    "--patch", "--no-patch", "--abbrev-commit", "--no-abbrev-commit", "--no-decorate", "--graph",
    "--all", "--branches", "--tags", "--remotes", "--no-merges", "--merges", "--first-parent",
    "--reverse", "--follow", "--cached", "--staged", "--no-color", "--ignore-all-space",
    "--ignore-space-change", "--ignore-blank-lines", "--check", "--minimal", "--histogram",
    "--patience", "--exit-code", "--quiet", "--no-ext-diff", "--no-textconv", "--left-right",
    "--cherry-pick", "--cherry-mark", "--boundary", "--topo-order", "--date-order",
    "--full-history", "--simplify-by-decoration", "--source", "--full-diff", "--no-renames",
    "--text", "--compact-summary", "--no-walk", "--count", "--regexp-ignore-case",
    "--extended-regexp", "--fixed-strings", "--all-match", "--invert-grep", "--summary",
    "--numbered", "--email", "--committer", "--no-prefix", "--name-only",
  ],
  longValue: [
    "--format", "--date", "--since", "--until", "--after", "--before", "--author", "--committer",
    "--grep", "--max-count", "--skip", "--diff-filter", "--min-parents", "--max-parents",
  ],
  longOptional: [
    "--stat", "--dirstat", "--color", "--word-diff", "--relative", "--abbrev", "--decorate",
    "--pretty", "--find-renames", "--find-copies", "--unified",
  ],
};

/** Per-subcommand flags for the git subcommands that only read. */
const GIT: Record<string, FlagSpec> = {
  log: GIT_HISTORY,
  show: GIT_HISTORY,
  diff: GIT_HISTORY,
  "rev-list": GIT_HISTORY,
  shortlog: GIT_HISTORY,
  status: {
    short: "sbz",
    shortAttached: "u",
    long: ["--short", "--branch", "--long", "--show-stash", "--no-ahead-behind", "--ahead-behind", "--renames", "--no-renames", "--null"],
    longOptional: ["--porcelain", "--untracked-files", "--ignored", "--ignore-submodules"],
  },
  grep: {
    short: "nilcwvFEPhHIozq",
    shortValue: "eABCm",
    long: [
      "--cached", "--untracked", "--no-index", "--name-only", "--files-with-matches",
      "--files-without-match", "--count", "--line-number", "--ignore-case", "--word-regexp",
      "--invert-match", "--fixed-strings", "--extended-regexp", "--perl-regexp", "--full-name",
      "--heading", "--break", "--show-function", "--column", "--only-matching", "--null", "--quiet",
      "--all-match", "--exclude-standard",
    ],
    longValue: ["--max-depth", "--context", "--after-context", "--before-context", "--max-count", "--threads"],
  },
  fetch: {
    short: "pqv",
    long: ["--prune", "--quiet", "--verbose", "--all", "--tags", "--no-tags", "--dry-run", "--progress", "--no-progress"],
    longValue: ["--jobs"],
  },
  "rev-parse": {
    short: "q",
    long: [
      "--show-toplevel", "--git-dir", "--git-common-dir", "--absolute-git-dir", "--is-inside-work-tree",
      "--is-bare-repository", "--show-prefix", "--show-cdup", "--symbolic-full-name", "--verify",
      "--quiet", "--show-superproject-working-tree", "--all", "--branches", "--tags", "--remotes",
    ],
    longOptional: ["--short", "--abbrev-ref"],
  },
  "ls-files": {
    short: "cdmoisuz",
    long: [
      "--cached", "--deleted", "--modified", "--others", "--ignored", "--stage", "--unmerged",
      "--exclude-standard", "--full-name", "--error-unmatch", "--directory", "--no-empty-directory",
      "--eol", "--deduplicate",
    ],
    longValue: ["--exclude"],
  },
  "ls-remote": { short: "htq", long: ["--heads", "--tags", "--refs", "--quiet", "--symref", "--get-url"], longValue: ["--sort"] },
  "ls-tree": { short: "rdtlz", long: ["--name-only", "--name-status", "--full-name", "--full-tree", "--long", "--object-only"], longValue: ["--format"], longOptional: ["--abbrev"] },
  "cat-file": { short: "tspe" },
  describe: { long: ["--tags", "--all", "--always", "--long", "--exact-match", "--contains"], longValue: ["--match", "--exclude", "--candidates"], longOptional: ["--abbrev", "--dirty"] },
  blame: { short: "lstwefnp", shortValue: "L", shortAttached: "MC", long: ["--porcelain", "--line-porcelain", "--show-email", "--show-name", "--show-number"], longValue: ["--date"] },
  "merge-base": { long: ["--is-ancestor", "--all", "--octopus", "--independent", "--fork-point"] },
  "show-ref": { short: "dsq", long: ["--heads", "--tags", "--head", "--verify", "--quiet", "--dereference"], longOptional: ["--hash", "--abbrev"] },
  "for-each-ref": { longValue: ["--format", "--sort", "--count", "--points-at", "--merged", "--no-merged", "--contains"] },
  "name-rev": { long: ["--name-only", "--tags", "--all"] },
  cherry: { short: "v" },
  "count-objects": { short: "vH" },
  "check-ignore": { short: "vnq", long: ["--verbose", "--non-matching", "--no-index", "--quiet"] },
};

/** `git branch` listing flags; a positional is a pattern only with `--list`, otherwise it creates a branch. */
const GIT_BRANCH: FlagSpec = {
  short: "avrl",
  long: ["--list", "--show-current", "--all", "--remotes", "--verbose"],
  longValue: ["--contains", "--merged", "--no-merged", "--points-at", "--format", "--sort"],
};

const GIT_TAG: FlagSpec = {
  short: "l",
  long: ["--list"],
  longValue: ["--sort", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "--format"],
};

function gitReadOnly(args: string[]): boolean {
  let rest = args;
  // `git -C <dir>` and pager suppression are the only global options allowed.
  for (;;) {
    if (rest[0] === "-C" && rest.length >= 2) rest = rest.slice(2);
    else if (rest[0] === "--no-pager" || rest[0] === "-P") rest = rest.slice(1);
    else break;
  }
  const [sub, ...subArgs] = rest;
  if (!sub) return false;
  const spec = GIT[sub];
  if (spec) {
    const positionals = positionalsIfAllowed(subArgs, spec);
    if (!positionals) return false;
    // A refspec with a destination (`+main:main`) can overwrite a local branch.
    if (sub === "fetch") return !positionals.some((arg) => arg.includes(":") && !arg.includes("://"));
    return true;
  }
  switch (sub) {
    case "branch": {
      const positionals = positionalsIfAllowed(subArgs, GIT_BRANCH);
      return !!positionals && (positionals.length === 0 || subArgs.includes("--list") || subArgs.includes("-l"));
    }
    case "stash":
      return (subArgs[0] === "list" || subArgs[0] === "show") && !!positionalsIfAllowed(subArgs.slice(1), GIT_HISTORY);
    case "reflog": {
      // Bare `git reflog` and `show` list; `expire` and `delete` erase recovery history.
      const listing = subArgs[0] === "show" ? subArgs.slice(1) : subArgs;
      const positionals = positionalsIfAllowed(listing, GIT_HISTORY);
      return !!positionals && !positionals.some((arg) => /^(expire|delete|drop|exists)$/u.test(arg));
    }
    case "worktree":
      return subArgs[0] === "list" && !!positionalsIfAllowed(subArgs.slice(1), { short: "v", long: ["--porcelain", "--verbose"] });
    case "remote":
      return (subArgs.length === 0 || (subArgs.length === 1 && (subArgs[0] === "-v" || subArgs[0] === "--verbose")))
        || ((subArgs[0] === "show" || subArgs[0] === "get-url") && subArgs.slice(1).every((arg) => !arg.startsWith("-")));
    case "tag": {
      // As with branch: a positional is a pattern only with --list, otherwise it creates a tag.
      const positionals = positionalsIfAllowed(subArgs, GIT_TAG);
      return !!positionals && (positionals.length === 0 || subArgs.includes("--list") || subArgs.includes("-l"));
    }
    case "config":
      return /^(--get|--get-all|--get-regexp|--list|-l)$/u.test(subArgs[0] ?? "")
        && !!positionalsIfAllowed(subArgs.slice(1), { long: ["--global", "--local", "--system", "--show-origin", "--show-scope", "--null"] });
    default:
      return false;
  }
}

/** gh subcommands whose every form reads. */
const GH_READ: Record<string, ReadonlySet<string>> = {
  pr: new Set(["view", "list", "diff", "status", "checks"]),
  run: new Set(["list", "view"]),
  issue: new Set(["view", "list", "status"]),
  repo: new Set(["view", "list"]),
  release: new Set(["list", "view"]),
  workflow: new Set(["list", "view"]),
  label: new Set(["list"]),
  search: new Set(["repos", "issues", "prs", "code", "commits"]),
};

const GH_FLAGS: FlagSpec = {
  short: "c",
  shortValue: "qtRLsAalBHSbwejiu",
  long: [
    "--comments", "--log", "--log-failed", "--exit-status", "--watch", "--required", "--fail-fast",
    "--verbose", "--name-only", "--patch", "--draft", "--archived", "--fork", "--source",
  ],
  longValue: [
    "--json", "--jq", "--template", "--repo", "--limit", "--state", "--author", "--assignee",
    "--label", "--base", "--head", "--search", "--branch", "--workflow", "--event", "--status",
    "--user", "--commit", "--created", "--job", "--attempt", "--interval", "--owner", "--language",
    "--sort", "--order", "--match", "--filename", "--extension", "--hostname", "--mention",
    "--milestone", "--app", "--visibility", "--topic", "--color",
  ],
};

/** `gh api` without a method or a body is a GET. */
const GH_API: FlagSpec = {
  short: "i",
  shortValue: "qtH",
  long: ["--paginate", "--slurp", "--include", "--silent", "--verbose"],
  longValue: ["--jq", "--template", "--header", "--cache", "--hostname"],
};

function ghReadOnly(args: string[]): boolean {
  const [area, action, ...rest] = args;
  if (area === "api") return !!positionalsIfAllowed(args.slice(1), GH_API);
  if (area === "auth") return action === "status" && !!positionalsIfAllowed(rest, { long: ["--active"], longValue: ["--hostname"] });
  const actions = area ? GH_READ[area] : undefined;
  return !!actions && !!action && actions.has(action) && !!positionalsIfAllowed(rest, GH_FLAGS);
}

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
      // Bash's double-quote rules: backslash escapes only $ ` " \ and newline, and a
      // backslash-newline disappears; any other backslash is literal.
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j];
        // Any expansion inside double quotes is a value this parser cannot see.
        if (d === "$" || d === "`") return undefined;
        if (d === "\\" && j + 1 < command.length) {
          const next = command[j + 1];
          if (next === "\n") {
            j++;
            continue;
          }
          if (next === '"' || next === "\\") {
            word += next;
            j++;
            continue;
          }
          if (next === "$" || next === "`") return undefined;
        }
        word += d;
      }
      if (j >= command.length) return undefined;
      inWord = true;
      i = j;
      continue;
    }
    if (c === "\\") {
      if (i + 1 >= command.length) return undefined;
      if (command[i + 1] !== "\n") {
        word += command[i + 1];
        inWord = true;
      }
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
        // fd duplication (`2>&1`, `>&2`, `<&0`) or closing (`>&-`) touches no file. The
        // whole word must be the fd: bash reads `>&1report.txt` as a redirect into a file.
        let k = j;
        while (k < command.length && !/[\s;&|<>()]/u.test(command[k])) k++;
        if (!/^(\d+-?|-)$/u.test(command.slice(j, k))) return undefined;
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

function segmentReadOnly(words: string[]): boolean {
  const [program, ...args] = words;
  if (!program) return false;
  // `timeout <duration> cmd` only bounds how long a read-only command runs.
  if (program === "timeout") {
    const positionals = positionalsIfAllowed(args.slice(0, 1), { long: ["--foreground", "--preserve-status"] });
    let rest = args;
    while (rest[0] === "--foreground" || rest[0] === "--preserve-status") rest = rest.slice(1);
    if (!positionals || !rest[0] || !/^\d+(\.\d+)?[smhd]?$/u.test(rest[0])) return false;
    return segmentReadOnly(rest.slice(1));
  }
  if (program === "git") return gitReadOnly(args);
  if (program === "gh") return ghReadOnly(args);
  if (program === "rg") return !!positionalsIfAllowed(args, RG);
  if (program === "command") return args.length === 2 && (args[0] === "-v" || args[0] === "-V");
  // jq cannot write or execute, but its filter can read the environment.
  if (program === "jq") return !args.some((arg) => /\$ENV|\benv\b/u.test(arg));
  return PURE.has(program);
}

/** True when every command in `command` is a known read-only program given only allowed arguments. */
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
