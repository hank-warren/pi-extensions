/**
 * The whole `/loop` grammar, which is now two cases:
 *
 *   /loop          -> the menu (context-sensitive: launch, planning, approval, manager)
 *   /loop <text>   -> open planning and send <text> as the first drafting message
 *
 * Everything else that used to live here — a typed start (`/loop 5m fix CI`),
 * its flags, and the `status|pause|resume|stop|settings` subcommands — is
 * gone. A loop's objective becomes its acceptance gate, and a command line is
 * the worst place to author one: the flags were invisible, the interval was
 * mandatory for no reason a user could see, and the criteria were frozen
 * before anyone had seen them. Planning plus an approval card replaces all of
 * it, and the menu carries the lifecycle actions the subcommands used to.
 *
 * Consequence worth stating plainly: `/loop status` is no longer a
 * subcommand, so it seeds planning with the word "status". That is the price
 * of having exactly one way in, and the menu is one keystroke away.
 */

type LoopCommand =
	/** Bare `/loop`: open whichever menu the current state calls for. */
	| { kind: "menu" }
	/** `/loop <text>`: enter planning and send the text as the first message. */
	| { kind: "seed"; text: string };

export function parseLoopCommand(args: string): LoopCommand {
	const trimmed = args.trim();
	return trimmed ? { kind: "seed", text: trimmed } : { kind: "menu" };
}

/**
 * The arguments a loop is built from.
 *
 * Only two callers construct these now — the approval card's start actions —
 * so the shape is the approved draft, not a parsed command line.
 */
export interface LoopStartArguments {
	kind: "start";
	requestedMs: number;
	intervalMs: number;
	clamped: boolean;
	/** Loop-caused-turn cap: undefined = use settings default; null = unlimited. */
	maxTurns?: number | null;
	/** undefined = use settings default; null = disabled for this loop. */
	compactAt?: number | null;
	/** Per-loop lifetime in ms; undefined = use the settings default. */
	expiresInMs?: number;
	prompt?: string;
	/**
	 * Completion criteria proposed with the draft, replacing the deterministic
	 * split of the objective.
	 */
	criteria?: string[];
	/** Hard constraints carried into the loop's per-turn objective append. */
	groundRules?: string[];
}
