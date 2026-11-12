import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** The slice of the rex CLI this package uses, so tests can stand in for it. */
export interface Rex {
	/** Run `rex <args>` and resolve with stdout; rejects with rex's own message. */
	run(args: string[], signal?: AbortSignal): Promise<string>;
	/** Stream one session's events until the returned function is called. `onClose` fires if the stream ends on its own. */
	events(session: string, onEvent: (event: RexEvent) => void, onClose: () => void): () => void;
}

export type RexEvent =
	| { type: "status"; block: string; state: string; kind?: string; msg?: string }
	| { type: "exited"; block: string; code?: number }
	| { type: "closed"; block: string };

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined);
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** One line of `rex events -s SESSION --json`, reduced to what a parent acts on. */
export function parseEvent(line: string): RexEvent | undefined {
	let outer: Json | undefined;
	try {
		outer = obj(JSON.parse(line));
	} catch {
		return undefined;
	}
	const event = obj(obj(outer?.payload)?.event);
	const payload = obj(event?.payload);
	const block = str(payload?.block_id);
	if (!event || !payload || !block) return undefined;
	if (event.type === "block_closed") return { type: "closed", block };
	if (event.type !== "block_event" || payload.creator_name !== "com.superlogical.terminal") return undefined;
	const inner = obj(payload.payload) ?? {};
	if (payload.name === "child_exited") return { type: "exited", block, code: typeof inner.exit_code === "number" ? inner.exit_code : undefined };
	if (payload.name !== "program_status_changed") return undefined;
	// A record with an id is a sub-task of the program; only the root record is the agent's own state.
	if (str(inner.id)) return undefined;
	const record = obj(inner.record);
	const state = str(record?.state);
	if (!state) return undefined;
	return { type: "status", block, state, kind: str(record?.kind), msg: str(record?.msg) };
}

export function rexCli(command = "rex"): Rex {
	return {
		run(args, signal) {
			return new Promise((resolve, reject) => {
				execFile(command, args, { signal, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
					if (error) reject(new Error(`rex ${args[0]}: ${stderr.trim() || error.message}`));
					else resolve(stdout);
				});
			});
		},
		events(session, onEvent, onClose) {
			const child = spawn(command, ["events", "-s", session, "--json"], { stdio: ["ignore", "pipe", "ignore"] });
			let stopped = false;
			createInterface({ input: child.stdout }).on("line", (line) => {
				const event = parseEvent(line);
				if (event && !stopped) onEvent(event);
			});
			const closed = () => {
				if (stopped) return;
				stopped = true;
				onClose();
			};
			child.on("error", closed);
			child.on("close", closed);
			return () => {
				stopped = true;
				child.kill();
			};
		},
	};
}
