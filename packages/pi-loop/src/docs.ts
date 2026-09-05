import { join } from "node:path";

/**
 * The loop-craft document: the judgment the engine cannot encode — how an
 * objective becomes falsifiable criteria, what the evidence gate accepts as a
 * citation, when to `loop_wait`, and when work belongs in no loop at all.
 *
 * It used to ship as a skill. A skill buys one thing an injected pointer
 * cannot: a description line in every system prompt, so the model could
 * propose a loop unprompted. Across ~220 sessions after it shipped, every read
 * of the file was triggered by the planning hint or `loop_complete`'s
 * guidelines — never by the description — and the model never suggested
 * `/loop` on its own. So the line was a tax on every session that never ran a
 * loop (~95% of them) and bought nothing. An absolute path, injected only
 * while a loop is being drafted or completed, is the same document at zero
 * cost outside those moments, and a hard path beats "if it is available".
 *
 * The path is resolved from this module's own location so it survives every
 * install layout (git, npm, workspace symlink, `npm link`).
 */
export const LOOP_CRAFT_DOC = join(import.meta.dirname, "..", "docs", "loop-craft.md");
