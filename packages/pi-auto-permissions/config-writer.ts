/**
 * Narrow, merging writer for the auto-permissions config file.
 *
 * The config is hand-maintained: rules, the system prompt, evidence knobs and
 * log paths all live in the same JSON object the `/auto-permissions` menu
 * edits. So this writer never serializes a whole config snapshot -- it re-reads
 * the file, patches only the keys one edit touched, and writes the result back
 * atomically. Anything it does not know about (including keys a future version
 * adds, and edits another session made a second ago) survives untouched.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pid } from "node:process";
import { autoPermissionsConfigPath, type ReasoningEffort } from "./config.js";

export { autoPermissionsConfigPath };

/** The subset of the config the settings UI owns. */
export interface ReviewerBlock {
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  timeoutMs: number;
}

interface ConfigPatch {
  enabled?: boolean;
  reviewer?: ReviewerBlock;
  /**
   * Entries to append to `guardianPolicy.environment` (the setup wizard's
   * accept path). Deduplicated against what is already there; every other
   * `guardianPolicy` list and unrelated key is left exactly as written.
   */
  appendEnvironment?: string[];
  /** Entries to append to `guardianPolicy.softDeny`, with the same semantics. */
  appendSoftDeny?: string[];
}

const DEFAULT_INDENT = "  ";

/**
 * Keep the file looking like the human left it. Only the first indented line
 * matters: JSON.stringify takes a single indent string for the whole document.
 */
export function detectIndent(text: string): string {
  const match = /\n([ \t]+)\S/.exec(text);
  if (!match) return DEFAULT_INDENT;
  const indent = match[1] ?? DEFAULT_INDENT;
  return indent.startsWith("\t") ? "\t" : indent;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function parseObject(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("auto permissions config must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Apply `patch` to the object currently on disk and rewrite the file.
 *
 * Sparse `enabled`: the loader reads a missing key as enabled, so turning the
 * guardian back on deletes the key rather than writing `true`. That keeps a
 * default flip reaching hosts that never touched the setting, matching how
 * pi-statusline serializes its settings.
 *
 * Throws on an unparsable or non-object file rather than clobbering it; the
 * caller surfaces that as a notification.
 */
export function patchAutoPermissionsConfig(
  path: string = autoPermissionsConfigPath(),
  patch: ConfigPatch = {},
): void {
  const existing = readText(path);
  const merged = parseObject(existing);

  if (patch.enabled !== undefined) {
    if (patch.enabled) delete merged.enabled;
    else merged.enabled = false;
  }
  if (patch.reviewer !== undefined) {
    // Preserve file-only reviewer keys the menu does not edit (prefilter):
    // this writer must never silently drop what the human wrote by hand.
    const existingReviewer = merged.reviewer && typeof merged.reviewer === "object" && !Array.isArray(merged.reviewer)
      ? merged.reviewer as Record<string, unknown>
      : {};
    merged.reviewer = {
      provider: patch.reviewer.provider,
      model: patch.reviewer.model,
      reasoningEffort: patch.reviewer.reasoningEffort,
      timeoutMs: patch.reviewer.timeoutMs,
      ...(existingReviewer.prefilter !== undefined ? { prefilter: existingReviewer.prefilter } : {}),
    };
  }

  const policyAppends = [
    ["environment", patch.appendEnvironment],
    ["softDeny", patch.appendSoftDeny],
  ] as const;
  if (policyAppends.some(([, entries]) => entries?.length)) {
    const policy = merged.guardianPolicy && typeof merged.guardianPolicy === "object" && !Array.isArray(merged.guardianPolicy)
      ? merged.guardianPolicy as Record<string, unknown>
      : {};
    for (const [key, entries] of policyAppends) {
      if (!entries?.length) continue;
      const existingEntries = Array.isArray(policy[key])
        ? policy[key].filter((entry): entry is string => typeof entry === "string")
        : [];
      policy[key] = [
        ...new Set([
          ...existingEntries,
          ...entries.map((entry) => entry.trim()).filter(Boolean),
        ]),
      ];
    }
    merged.guardianPolicy = policy;
  }

  const payload = `${JSON.stringify(merged, null, detectIndent(existing))}\n`;
  const temporary = `${path}.${pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporary, payload, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    throw error;
  }
}
