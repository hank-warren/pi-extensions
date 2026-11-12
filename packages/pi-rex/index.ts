/**
 * pi-rex: start Pi agents in Rex tabs and get their results back.
 *
 * A parent Pi running in a Rex terminal starts each child as a full interactive
 * Pi in its own tab. Rex reports what each child is doing (working, blocked,
 * exited); each child reports the result of every run through a spool directory.
 * Both arrive in the parent as messages, so it never polls.
 */
import { existsSync } from "node:fs";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CHILD_DIR_ENV, CHILD_NAME_ENV, registerChild } from "./child.ts";
import { forwardedExtensions, registerTools, RexParent } from "./parent.ts";
import { rexCli } from "./rex.ts";

const STARTUP_CWD = process.cwd();

/** This process's own pi CLI, so children run the same Pi and Node, with the same `-e` extensions. */
function piCommand(): string[] {
	const script = process.argv[1];
	const extensions = forwardedExtensions(process.argv.slice(2), STARTUP_CWD);
	if (script && existsSync(script) && /(?:^|[\\/])(?:cli\.m?js|pi)$/.test(script)) return [process.execPath, script, ...extensions];
	return ["pi", ...extensions];
}

export default function piRex(pi: ExtensionAPI): void {
	const childDir = process.env[CHILD_DIR_ENV];
	if (childDir) {
		registerChild(pi, childDir, process.env[CHILD_NAME_ENV] ?? "child");
		return;
	}

	const parent = new RexParent(pi, { rex: rexCli(), agentDir: getAgentDir, env: process.env, piCommand });

	// Outside Rex the tools are withdrawn. In Rex they are codemode tools when the session has codemode.
	const exposure = (): "codemode" | "direct" | "hidden" => {
		if (!process.env.REX_SESSION) return "hidden";
		try {
			return pi.getActiveTools().includes("codemode") ? "codemode" : "direct";
		} catch {
			// Not available while extensions load: assume codemode until session_start knows.
			return "codemode";
		}
	};
	let registered = exposure();
	registerTools(pi, parent, registered);

	pi.on("session_start", async (_event, ctx) => {
		const now = exposure();
		if (now !== registered) {
			registered = now;
			registerTools(pi, parent, now);
		}
		await parent.start(ctx);
	});

	pi.on("session_shutdown", () => parent.stop());
}
