/**
 * Read-only fast path for `reviewAllShell`: a command that can neither change
 * anything nor print anything beyond names, counts and the project's own
 * history skips the blanket review. Guardian reviews are cheap; this exists to
 * skip the obviously harmless ones, not to be clever.
 *
 * An allowlist all the way down, kept deliberately small:
 * - META programs print metadata only (names, sizes, counts, hashes), whatever
 *   their arguments.
 * - STDIN_FILTERS (`head`, `grep`, `wc`, ...) take listed flags and no file
 *   arguments, so they only ever see what an earlier, itself-checked part of
 *   the pipeline produced.
 * - Read-only `git` and `gh` subcommands take listed flags only.
 * Anything else — a program that reads file contents (`cat`, `rg`), a
 * program with a language of its own (`jq`, `awk`, `sed`), an
 * unknown program, subcommand or flag, an unquoted glob, a substitution or
 * expansion, a subshell, a here-doc, a background job, an env-prefixed
 * command, a write redirect other than to /dev/null — goes to the guardian.
 * A forgotten safe case costs one review; no list here names unsafe flags.
 */

/**
 * Programs that print only metadata (names, sizes), never file contents. The
 * builtins among them (cd, echo, pwd, type, true, false) never evaluate their
 * arguments; `test` is absent because `test -v 'a[$(cmd)]'` runs cmd.
 */
const META = new Set([
  "ls", "pwd", "stat", "df", "free", "id", "whoami", "uname", "uptime", "which", "type",
  "basename", "dirname", "realpath", "readlink", "nproc", "true", "false", "sleep", "cd",
  "echo",
]);

/** The flags a program may be given. Anything else is not read-only. */
interface FlagSpec {
  /** Boolean short flags, combinable (`-niw`). */
  short?: string;
  /**
   * Short flags taking the rest of this argument (`-A3`) or the next one (`-e PAT`). A
   * next argument starting with `-` (including `--`) is ambiguous: not read-only.
   */
  shortValue?: string;
  /** Short flags taking an attached value only (`-M50%`); never the next argument. */
  shortAttached?: string;
  /** Boolean long flags. */
  long?: readonly string[];
  /**
   * Long flags taking a value. Only the attached `--flag=value` form is read as
   * one: whether a program takes a separate value, and whether it is optional,
   * varies (`grep --color`), so a following plain argument is checked as a
   * positional, and a following one starting with `-` (including `--`, which a
   * program may take as the value) is ambiguous: not read-only.
   */
  longValue?: readonly string[];
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
        // A program may take the next argument as this flag's value, even `--`: then a
        // following flag-like argument is ambiguous, and ambiguity goes to review.
        if (eq < 0 && args[i + 1]?.startsWith("-")) return undefined;
        continue;
      }
      if (eq < 0 && spec.long?.includes(name)) continue;
      return undefined;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (spec.numeric && /^-\d+$/u.test(arg)) continue;
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (spec.shortValue?.includes(flag)) {
          if (j === arg.length - 1 && i + 1 < args.length) {
            // Whether the program takes the next argument as the value (even `--`) or this
            // flag is really a boolean (`git shortlog -n`), a flag-like next argument is
            // ambiguous and goes to review; a plain one is taken as the value.
            if (args[i + 1].startsWith("-")) return undefined;
            i++;
          }
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

/**
 * Filters allowed with no file arguments, so they read only their pipe.
 * `positionals` is how many non-flag arguments each takes (patterns, filters,
 * character sets), never paths.
 */
const STDIN_FILTERS: Record<string, { spec: FlagSpec; positionals: (args: readonly string[]) => number }> = {
  head: { spec: { short: "qvz", shortValue: "nc", numeric: true, longValue: ["--lines", "--bytes"], long: ["--quiet", "--silent", "--verbose", "--zero-terminated"] }, positionals: () => 0 },
  tail: { spec: { short: "qvzfF", shortValue: "nc", numeric: true, longValue: ["--lines", "--bytes"], long: ["--quiet", "--silent", "--verbose", "--zero-terminated"] }, positionals: () => 0 },
  cut: { spec: { short: "sz", shortValue: "dfcb", longValue: ["--delimiter", "--fields", "--characters", "--bytes", "--output-delimiter"], long: ["--complement", "--only-delimited", "--zero-terminated"] }, positionals: () => 0 },
  tr: { spec: { short: "cCdst" }, positionals: () => 2 },
  // No --files0-from: it reads a file and echoes its contents in errors.
  wc: { spec: { short: "lwcmL", long: ["--lines", "--words", "--bytes", "--chars", "--max-line-length"] }, positionals: () => 0 },
  // No -r/-R/-d/--include/-f: those read files.
  grep: { spec: GREP_SPEC(), positionals: (args) => (args.some((arg) => /^-[^-]*e|^--regexp/u.test(arg)) ? 0 : 1) },
  egrep: { spec: GREP_SPEC(), positionals: (args) => (args.some((arg) => /^-[^-]*e|^--regexp/u.test(arg)) ? 0 : 1) },
  fgrep: { spec: GREP_SPEC(), positionals: (args) => (args.some((arg) => /^-[^-]*e|^--regexp/u.test(arg)) ? 0 : 1) },
};

function GREP_SPEC(): FlagSpec {
  return {
    short: "nivcwxoqsEFGPlLHhbzZIUa",
    shortValue: "eABCm",
    long: [
      "--line-number", "--ignore-case", "--invert-match", "--count", "--word-regexp", "--line-regexp",
      "--only-matching", "--quiet", "--silent", "--no-messages", "--extended-regexp", "--fixed-strings",
      "--basic-regexp", "--perl-regexp", "--with-filename", "--no-filename", "--byte-offset", "--null",
      "--null-data", "--text",
    ],
    longValue: ["--regexp", "--after-context", "--before-context", "--context", "--max-count", "--color", "--colour", "--label"],
  };
}

/** Flags shared by git's history readers (log, show, rev-list, stash show, reflog). */
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
    "--stat", "--dirstat", "--color", "--word-diff", "--relative", "--abbrev", "--decorate",
    "--pretty", "--find-renames", "--find-copies", "--unified",
  ],
};

/**
 * Per-subcommand flags for the git subcommands that only read the repository's
 * own objects. `diff` and `grep` are absent: outside a worktree (or with a path
 * outside it) they fall back to reading arbitrary files.
 */
const GIT: Record<string, FlagSpec> = {
  log: GIT_HISTORY,
  show: GIT_HISTORY,
  "rev-list": GIT_HISTORY,
  // Its -n (sort by count) is a boolean, unlike log's -n <count>.
  shortlog: {
    short: "nsec",
    long: ["--numbered", "--summary", "--email", "--committer", "--all", "--no-merges", "--merges"],
    longValue: ["--since", "--until", "--after", "--before", "--author", "--format", "--group"],
  },
  status: {
    short: "sbz",
    shortAttached: "u",
    long: ["--short", "--branch", "--long", "--show-stash", "--no-ahead-behind", "--ahead-behind", "--renames", "--no-renames", "--null"],
    longValue: ["--porcelain", "--untracked-files", "--ignored", "--ignore-submodules"],
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
    longValue: ["--short", "--abbrev-ref"],
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
  // Not --get-url: it prints the remote URL as configured, token included.
  "ls-remote": { short: "htq", long: ["--heads", "--tags", "--refs", "--quiet", "--symref"], longValue: ["--sort"] },
  "ls-tree": { short: "rdtlz", long: ["--name-only", "--name-status", "--full-name", "--full-tree", "--long", "--object-only"], longValue: ["--format", "--abbrev"] },
  "cat-file": { short: "tspe" },
  describe: { long: ["--tags", "--all", "--always", "--long", "--exact-match", "--contains"], longValue: ["--match", "--exclude", "--candidates", "--abbrev", "--dirty"] },
  blame: { short: "lstwefnp", shortValue: "L", shortAttached: "MC", long: ["--porcelain", "--line-porcelain", "--show-email", "--show-name", "--show-number"], longValue: ["--date"] },
  "merge-base": { long: ["--is-ancestor", "--all", "--octopus", "--independent", "--fork-point"] },
  "show-ref": { short: "dsq", long: ["--heads", "--tags", "--head", "--verify", "--quiet", "--dereference"], longValue: ["--hash", "--abbrev"] },
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
    case "tag": {
      // As with branch: a positional is a pattern only with --list, otherwise it creates a tag.
      const positionals = positionalsIfAllowed(subArgs, GIT_TAG);
      return !!positionals && (positionals.length === 0 || subArgs.includes("--list") || subArgs.includes("-l"));
    }
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
  // Not -w: it is --web, a boolean, on the view commands, and a value flag would swallow the next argument.
  shortValue: "qtRLsAalBHSbejiu",
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
    // An unquoted glob expands to file names this parser never sees, any of which can be a flag.
    if (c === "*" || c === "?" || c === "[") return undefined;
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
      // Input redirects feed a file to a filter that must read only its pipe; here-docs,
      // here-strings and process substitution carry content this parser does not read.
      if (op.includes("<") || command[j] === "(") return undefined;
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
      // Output redirects are allowed only into /dev/null.
      if (target !== "/dev/null") return undefined;
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
  if (program === "command") return args.length === 2 && (args[0] === "-v" || args[0] === "-V");
  const filter = STDIN_FILTERS[program];
  if (filter) {
    const positionals = positionalsIfAllowed(args, filter.spec);
    return !!positionals && positionals.length <= filter.positionals(args);
  }
  return META.has(program);
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
