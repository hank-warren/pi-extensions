import { DEFAULT_TIMEOUT_MS, MAX_OUTPUT_WIDTH, MAX_TIMEOUT_MS } from "./custom.ts";

/**
 * The message `/statusline` → Custom item list → "Add custom item…" sends on the
 * user's behalf.
 *
 * This is how the contract reaches the agent. It is not a skill on purpose: a
 * skill's description line sits in every system prompt of every session with
 * the statusline loaded, to serve a task most users do once. Injecting the
 * contract from the menu costs nothing until someone asks for an item, and it
 * is discoverable where the feature is — the same shape Claude Code's own
 * `/statusline` takes.
 *
 * Everything the agent needs is in the message, because the README's install
 * path is not guessable from inside a session (`~/.pi/agent/npm/node_modules/…`
 * for an npm install, a git checkout for a git one).
 */
export function buildCustomItemSetupPrompt(settingsPath: string, request: string): string {
	const want = request.trim();
	const ask =
		want.length > 0
			? `I want a custom statusline item that shows: ${want}`
			: "I want to add a custom statusline item. Ask me what it should show, then set it up.";
	return [
		ask,
		"",
		"Set it up for pi-statusline. The contract is Claude Code's `statusLine` contract, per item:",
		"",
		// An instruction, not a fact: given "items live in <path>", a weaker model
		// in a canary treated the path as a hint and went looking for the "real"
		// file with `find /`. The path is the one this session is actually using.
		`- Write the entry to exactly \`${settingsPath}\` under \`customItems\` (an array). That is the file this session reads; do not search for or edit any other settings file. Create the file or the key if absent, and preserve everything else in it.`,
		"- Each entry: `{ \"id\": \"<short-name>\", \"command\": \"<shell line>\", \"refreshInterval\": <seconds, optional>, \"timeout\": <seconds, optional> }`. The command runs through `sh -c`, so pipes, `$VARS`, and `~` work.",
		"- The command receives one JSON object on **stdin** and `COLUMNS` in its environment. Fields: `session_id`, `cwd`, `model.id`, `model.provider`, `git` (`{branch, dirty, behind}` or `null`), `context_window` (`{used_tokens, context_window_size, used_percentage}`, `used_tokens` may be `null`), `usage_remaining.claude` (`{five_hour, seven_day, scoped_weekly}` or `null`) and `usage_remaining.codex` (`{five_hour, weekly}` or `null`). Those percentages are **remaining** headroom, not used.",
		`- The **first line of stdout** becomes the segment, capped at ${MAX_OUTPUT_WIDTH} characters. SGR colour escapes pass through; every other escape sequence is stripped. **Empty output hides the item** — it is a valid answer, not a failure. Exit non-zero to report a failure; the first line of stderr is shown in \`/statusline\`.`,
		"- It runs at session start, at the end of every turn, and every `refreshInterval` seconds if set. Use `refreshInterval` for values that move on a wall clock rather than on turns. One run per item at a time; a slow command degrades to a lower refresh rate.",
		`- Default timeout ${DEFAULT_TIMEOUT_MS / 1000}s, maximum ${MAX_TIMEOUT_MS / 1000}s. Keep it fast: do slow work in a cron job or daemon and have the item read the result; if the item must do the work itself, cache keyed by \`session_id\`.`,
		"",
		"Steps: write the script if one is needed (make it executable), test it exactly as the statusline runs it — `echo '{\"model\":{\"id\":\"x\"},\"usage_remaining\":{\"codex\":{\"five_hour\":22,\"weekly\":55}}}' | COLUMNS=120 sh -c '<command>'` — and confirm it prints one short line. Then add the entry to the settings file. When done, tell me to run `/statusline` to reload it; the file is read when that menu opens, and the **Custom item list** submenu shows each item's value or why it is not rendering.",
	].join("\n");
}
