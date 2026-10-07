import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** `~` and `~/…` to the home directory; anything else unchanged. */
export function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** The real path, or the resolved one for a path that does not exist. */
export function realPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}
