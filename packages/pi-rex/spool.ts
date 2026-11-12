import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A directory of JSON messages. The writer renames a finished file into place,
 * so a reader never sees a partial one; file names sort in send order.
 */
let counter = 0;

export function spoolWrite(dir: string, value: unknown): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const name = `${Date.now().toString().padStart(15, "0")}-${process.pid}-${(counter++).toString().padStart(6, "0")}.json`;
	const tmp = join(dir, `.${name}.tmp`);
	writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
	renameSync(tmp, join(dir, name));
	return name;
}

/** Hand every waiting message to `deliver`, oldest first, removing each one first so it is delivered once. */
export function spoolDrain<T>(dir: string, deliver: (value: T) => void): void {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return;
	}
	for (const name of names) {
		const path = join(dir, name);
		let value: T;
		try {
			value = JSON.parse(readFileSync(path, "utf8")) as T;
			unlinkSync(path);
		} catch {
			continue;
		}
		deliver(value);
	}
}

/** Drain now, on every change, and on a slow poll in case a change notification is lost. Returns a stop function. */
export function spoolWatch<T>(dir: string, deliver: (value: T) => void, pollMs = 2000): () => void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const drain = () => spoolDrain(dir, deliver);
	let watcher: ReturnType<typeof watch> | undefined;
	try {
		watcher = watch(dir, drain);
		watcher.on("error", () => undefined);
		// Like the poll, a watch alone does not keep the process running.
		watcher.unref();
	} catch {
		// The poll still delivers.
	}
	const poll = setInterval(drain, pollMs);
	poll.unref();
	drain();
	return () => {
		watcher?.close();
		clearInterval(poll);
	};
}
