import type { Gate } from "./gates.js";

/**
 * The built-in ruleset.
 *
 * Active when the config file has no `rules` key at all, and spliceable into
 * an authored `rules` array with the literal string `"$defaults"` (see
 * `expandRules` in config.ts). An authored array without the token fully
 * replaces this list; an explicit `[]` gates nothing.
 *
 * Content is derived from Claude Code auto mode's blocked-by-default list
 * (the mechanically matchable rows), adapted to this extension's levels:
 *
 * - `deny` — the analogue of CC's deterministic pre-classifier circuit
 *   breaker: oversight bypasses and critical-path destruction that no agent
 *   session should ever perform. Not overridable, not bypassed by trusted
 *   groups, never sent to the guardian.
 * - `guarded` — operations where a human judgment call is legitimate; the
 *   guardian reviews them against the conversation evidence.
 *
 * Design constraints, enforced by test/default-rules.test.ts:
 * - A normal dev session (build, test, commit, push a feature branch) must
 *   trigger zero gates. Plain `git commit` and `git push` are deliberately
 *   not gated; only force pushes, history rewrites, deploy-branch pushes and
 *   remote reconfiguration are.
 * - Every rule ships with commands that must match and near-misses that must
 *   not. Rules match raw shell text, so quoting and variable indirection can
 *   evade them — the guardian and the system prompt are the semantic layer;
 *   these rules are the deterministic prefilter.
 */

/** Shell-write prefix: redirection or a write verb, then no command separator. */
const WRITE = String.raw`(?:>>?|\btee\b|\bsed\s+-i\b|\bcp\b|\bmv\b)[^|&;]*`;

const OVERSIGHT_RULES: readonly Gate[] = [
  {
    pattern: /--dangerously-skip-permissions\b|--dangerously-bypass-approvals-and-sandbox\b|--yes-always\b|\b(?:pi|claude|codex)\b[^|&;]*--no-sandbox\b/i,
    level: "deny",
    group: "oversight",
    label: "Agent oversight bypass",
    message: "Launching an agent with approvals or sandboxing disabled removes the oversight this session runs under. Run the agent with its normal approval flow instead.",
  },
  {
    pattern: /\btmux\s+send-keys\b(?![^|&;]*\s-t)|\btmux\s+send-keys\b[^|&;]*\s-t[= ]?\s*['"]?\$\{?TMUX_PANE/i,
    level: "deny",
    group: "oversight",
    label: "Self-driving keystrokes",
    message: "Sending keystrokes to this agent's own terminal pane drives its own interface, which amounts to changing its own permissions or oversight. Target an explicit other pane with -t if you are automating a different process.",
  },
  {
    pattern: /(?:>>?|\btee\b|\bsed\s+-i\b|\bcp\b|\bmv\b|\brm\b|\btruncate\b)[^|&;]*(?:\$\{?PI_CODING_AGENT_DIR\}?|\.pi\/agent)\/sessions\b/i,
    level: "deny",
    group: "oversight",
    label: "Session transcript write",
    message: "Session transcripts are the audit record of agent behavior; writing to them from a session is never allowed. Reading them is fine.",
  },
];

const DESTRUCTIVE_RULES: readonly Gate[] = [
  {
    pattern: /\b(?:rm|rmdir)\b[^|&;]*\s['"]?\/[^/\s'"]*\/?['"]?(?=\s|$|[;|&])/i,
    level: "deny",
    group: "destructive",
    label: "Delete of a critical path",
    message: "Deleting the filesystem root or a top-level directory is irreversible system destruction. Name the specific deeper path you actually mean.",
  },
  {
    pattern: /\b(?:rm|rmdir)\b[^|&;]*\s['"]?(?:~|\$\{?HOME\}?)\/?['"]?(?=\s|$|[;|&])/i,
    level: "deny",
    group: "destructive",
    label: "Delete of the home directory",
    message: "Deleting the home directory is irreversible. Name the specific path under it you actually mean.",
  },
  {
    pattern: /\b(?:rm|rmdir)\b[^|&;]*\s['"]?\.\.?\/?['"]?(?=\s|$|[;|&])/i,
    level: "deny",
    group: "destructive",
    label: "Delete of the working directory or a parent",
    message: "Deleting the current directory or a parent destroys the workspace this session runs in. Name the specific entry inside it you actually mean.",
  },
  {
    pattern: /\brm\b[^|&;]*\s['"]?\$\{?[A-Za-z_]\w*\}?['"]?\/\*/i,
    level: "deny",
    group: "destructive",
    label: "Glob delete under a shell variable",
    message: "A glob rooted at a shell variable becomes a root delete when the variable is empty or unset. Re-run the delete with the resolved literal path written into the command.",
  },
  {
    pattern: /\brm\b[^|&;]*\s(?:['"]?\/tmp\/|['"]?\$\{?TMPDIR\}?[/'"]?)[^|&;]*\*/i,
    level: "guarded",
    group: "destructive",
    label: "Wildcard delete in shared temp",
  },
  {
    pattern: /\bfind\b[^|&;]*\s(?:-delete\b|-exec\s+rm\b)/i,
    level: "guarded",
    group: "destructive",
    label: "Filesystem sweep via find",
  },
  {
    pattern: /\brm\b[^|&;]*\s['"]?\$\{?[A-Za-z_]\w*\}?\/?['"]?(?=\s|$|[;|&])/i,
    level: "guarded",
    group: "destructive",
    label: "Delete of a shell-variable target",
  },
];

const GIT_RULES: readonly Gate[] = [
  {
    pattern: /\bgit\s+push\b[^|&;]*(?:\s--force\b|\s--force-with-lease\b|\s-f\b)/i,
    level: "guarded",
    group: "git",
    label: "Force push",
  },
  {
    pattern: /\bgit\s+(?:reset\s+--hard\b|checkout\s+--\s+\.(?=\s|$)|restore\s+\.(?=\s|$)|clean\s+-[a-z]*f|stash\s+(?:drop|clear)\b)/i,
    level: "guarded",
    group: "git",
    label: "Uncommitted-work destruction",
  },
  {
    pattern: /\bgit\s+commit\b[^|&;]*--amend\b/i,
    level: "guarded",
    group: "git",
    label: "Commit amend",
  },
  {
    pattern: /\bgit\s+remote\s+(?:add|set-url)\b/i,
    level: "guarded",
    group: "git",
    label: "Remote reconfiguration",
  },
  {
    pattern: /\bgit\s+push\b[^|&;]*[\s:](?:production|release|gh-pages)(?=\s|$|[:;|&])/i,
    level: "guarded",
    group: "git",
    label: "Push to a deploy branch",
  },
];

const IAC_RULES: readonly Gate[] = [
  {
    pattern: /\b(?:terraform|pulumi|cdk|terragrunt)\b[^|&;]*\bdestroy\b/i,
    level: "guarded",
    group: "iac",
    label: "Infrastructure destroy",
  },
  {
    pattern: /\bkubectl\b[^|&;]*\s(?:drain|delete\s+node|exec|port-forward)\b/i,
    level: "guarded",
    group: "iac",
    label: "Cluster node or pod intrusion",
  },
  {
    pattern: /\bkubectl\b[^|&;]*\s(?:delete|scale|patch|label|annotate|cordon|uncordon|taint)\b[^|&;]*(?:\s--all\b|\s-l[= ]|\s--selector[= ])/i,
    level: "guarded",
    group: "iac",
    label: "Cluster-wide write",
  },
];

const NET_EXEC_RULES: readonly Gate[] = [
  {
    pattern: /\b(?:curl|wget)\b[^|&;]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|python3?|perl|node)\b/i,
    level: "guarded",
    group: "net-exec",
    label: "Piped remote code execution",
  },
  {
    pattern: /\bngrok\b|\bcloudflared\s+tunnel\b|\bssh\b[^|&;]*\s-R\b|\/dev\/tcp\//i,
    level: "guarded",
    group: "net-exec",
    label: "Tunnel or reverse shell",
  },
];

const SECRETS_RULES: readonly Gate[] = [
  {
    pattern: /\baws\s+secretsmanager\s+(?:put|create|update|delete|rotate)|\bvault\s+kv\s+(?:put|patch|destroy|delete)|\bgcloud\s+dns\b|\bcertbot\b|\baz\s+keyvault\b[^|&;]*\s(?:set|import|delete)\b/i,
    level: "guarded",
    group: "secrets",
    label: "Secret store, DNS, or certificate write",
  },
  {
    pattern: /\benv\b\s*\|\s*grep\b[^|&;]*(?:key|token|secret|pass)|\bcat\b[^|&;]*\.env['"]?\s*[|>]|\bprintenv\b[^|&;]*(?:key|token|secret)/i,
    level: "guarded",
    group: "secrets",
    label: "Credential print",
  },
  {
    pattern: /\b(?:cat|cp|scp|rsync|curl|tar|base64|grep|head|tail)\b[^|&;]*(?:~|\$\{?HOME\}?)\/\.(?:ssh|aws|config\/gcloud)\b|\b(?:cat|grep|head|tail)\b[^|&;]*\.(?:bash_history|zsh_history)\b/i,
    level: "guarded",
    group: "secrets",
    label: "Credential store read",
  },
];

const SUPPLY_CHAIN_RULES: readonly Gate[] = [
  {
    pattern: /\b(?:npm|yarn|pnpm|bun)\b[^|&;]*\s--registry\b|\bpip3?\b[^|&;]*\s(?:-i|--index-url)[= ]/i,
    level: "guarded",
    group: "supply-chain",
    label: "Registry override install",
  },
  {
    pattern: /\bgh\s+repo\s+fork\b|\bgh\s+pr\s+create\b[^|&;]*\s(?:--repo|-R)[= ]/i,
    level: "guarded",
    group: "supply-chain",
    label: "Cross-repo contribution",
  },
];

const REVIEW_RULES: readonly Gate[] = [
  {
    pattern: /\bgh\s+pr\s+merge\b|\bgh\s+pr\s+review\b[^|&;]*--approve\b/i,
    level: "guarded",
    group: "review",
    label: "Merge or approve a pull request",
  },
  {
    pattern: /\bgit\s+(?:commit|push|merge)\b[^|&;]*--no-verify\b|\b(?:curl|wget)\b[^|&;]*(?:\s-k\b|\s--insecure\b)|--skip-checks\b/i,
    level: "guarded",
    group: "review",
    label: "Safety guard bypass flag",
  },
];

const PROTECTED_PATH_RULES: readonly Gate[] = [
  {
    pattern: new RegExp(WRITE + String.raw`['"]?(?:\S*\/)?\.(?:git\/|gitconfig\b|gitmodules\b)`, "i"),
    level: "guarded",
    group: "protected-paths",
    label: "Shell write to git internals",
  },
  {
    pattern: new RegExp(WRITE + String.raw`['"]?(?:\S*\/)?(?:\.(?:husky\/|pre-commit-config\.ya?ml\b)|\.?lefthook\.ya?ml\b)`, "i"),
    level: "guarded",
    group: "protected-paths",
    label: "Shell write to hook config",
  },
  {
    pattern: new RegExp(WRITE + String.raw`['"]?(?:\S*\/)?\.(?:bashrc\b|bash_profile\b|bash_aliases\b|bash_login\b|bash_logout\b|zshrc\b|zprofile\b|zshenv\b|zlogin\b|zlogout\b|profile\b|envrc\b|npmrc\b|yarnrc\b|cargo\/)`, "i"),
    level: "guarded",
    group: "protected-paths",
    label: "Shell write to shell or tool dotfiles",
  },
  {
    pattern: new RegExp(WRITE + String.raw`['"]?(?:\S*\/)?\.pi\/(?!agent\/sessions)`, "i"),
    level: "guarded",
    group: "protected-paths",
    label: "Shell write to project agent config",
  },
];

export const DEFAULT_RULES: readonly Gate[] = [
  ...OVERSIGHT_RULES,
  ...DESTRUCTIVE_RULES,
  ...GIT_RULES,
  ...IAC_RULES,
  ...NET_EXEC_RULES,
  ...SECRETS_RULES,
  ...SUPPLY_CHAIN_RULES,
  ...REVIEW_RULES,
  ...PROTECTED_PATH_RULES,
];
