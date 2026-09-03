import { watch } from "node:fs";
import { basename, dirname } from "node:path";

interface SettingsWatcherOptions {
	/** The settings file to follow; its directory is what actually gets watched. */
	path: string;
	debounceMs: number;
	onChange(): void;
}

/**
 * Follows one settings file for out-of-band edits.
 *
 * The watch is on the file's *directory* rather than the file itself: saves go
 * through a temp file and an atomic rename, and a watch bound to the old inode
 * would go deaf after the first one. One hand-edit or menu save also fans out
 * into several filesystem events (temp file created, renamed into place), so
 * `debounceMs` collapses them into a single `onChange`.
 */
export function createSettingsWatcher(options: SettingsWatcherOptions) {
	const watchedFile = basename(options.path);
	let watcher: ReturnType<typeof watch> | undefined;
	let reloadTimer: ReturnType<typeof setTimeout> | undefined;

	const stop = () => {
		if (reloadTimer) {
			clearTimeout(reloadTimer);
			reloadTimer = undefined;
		}
		watcher?.close();
		watcher = undefined;
	};

	return {
		start() {
			stop();
			try {
				const started = watch(dirname(options.path), { persistent: false }, (event, changed) => {
					if (event !== "rename" && event !== "change") return;
					// A null filename means the platform could not name the entry; reload
					// rather than miss the edit. The directory holds other churn, so a
					// named entry that is not ours is ignored.
					if (changed && changed.toString() !== watchedFile) return;
					if (reloadTimer) clearTimeout(reloadTimer);
					reloadTimer = setTimeout(() => {
						reloadTimer = undefined;
						options.onChange();
					}, options.debounceMs);
				});
				started.on("error", stop);
				watcher = started;
			} catch {
				// An unwatchable directory only costs the live reload; settings still
				// load at session start.
				stop();
			}
		},
		stop,
	};
}
