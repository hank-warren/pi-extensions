/**
 * FIFO serialization for guardian-backed reviews.
 *
 * Two guarded commands issued in the same assistant turn used to open two
 * reviewer conversations at once, which raced for the same widget/bash review
 * row and let the second verdict land against the first command's display. The
 * queue serializes the *decisions* only: denies, convention blocks, trusted
 * commands and already-approved execution never enter it.
 *
 * Every acquirer releases in a `finally`, and a release that throws (or is
 * never observed) must not poison later requests — so the tail is always a
 * settled-or-settling promise that swallows rejection.
 *
 * The critical section spans the human prompt as well as the model call, which
 * is deliberate: two approval dialogs fighting over one surface is the thing
 * this exists to prevent. That makes the wait unbounded in wall-clock time, so
 * it is cancellable (`acquire(signal)`) and visible (`busy`, which the caller
 * uses to render a "queued" row instead of a blank gap).
 */
interface ReviewQueue {
	/**
	 * Waits for the queue, then returns the release function for this slot.
	 *
	 * Rejects with the signal's reason if `signal` aborts first. An aborted
	 * waiter never takes the slot, and never lets the next waiter overtake the
	 * live holder — see the catch in the implementation.
	 */
	acquire(signal?: AbortSignal): Promise<() => void>;
	/** Slots currently waiting, excluding the one holding the queue. */
	readonly waiting: number;
	/** True while a slot is held, so a caller can show a queued state. */
	readonly busy: boolean;
}

export function createReviewQueue(): ReviewQueue {
	let tail: Promise<void> = Promise.resolve();
	let waiting = 0;
	let held = 0;

	return {
		async acquire(signal?: AbortSignal): Promise<() => void> {
			signal?.throwIfAborted();
			const previous = tail;
			let release = () => {};
			tail = new Promise<void>((resolve) => {
				release = resolve;
			});
			let released = false;
			const releaseOnce = () => {
				if (released) return;
				released = true;
				held -= 1;
				release();
			};
			waiting += 1;
			try {
				await (signal ? raceAbort(previous, signal) : previous.catch(() => undefined));
			} catch (error) {
				// Keep the chain intact: our slot resolves when the one ahead of us
				// does, so an aborted waiter never lets the next one overtake the live
				// holder. Resolving `release()` here instead would hand the queue to
				// the next waiter while the current holder is still inside its
				// critical section — silently undoing the mutual exclusion this class
				// exists to provide.
				released = true;
				void previous.catch(() => undefined).then(release);
				throw error;
			} finally {
				waiting -= 1;
			}
			held += 1;
			return releaseOnce;
		},
		get waiting() {
			return waiting;
		},
		get busy() {
			return held > 0;
		},
	};
}

/**
 * Resolve when `previous` settles, or reject when `signal` aborts.
 *
 * The listener is always removed: a session-lifetime signal outlives many
 * reviews, and one dangling listener per queued command is a slow leak that
 * would only show up under exactly the load this queue was added to handle.
 */
function raceAbort(previous: Promise<void>, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(signal.reason);
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		previous.catch(() => undefined).then(() => {
			cleanup();
			resolve();
		}, cleanup);
	});
}
