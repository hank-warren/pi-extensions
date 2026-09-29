/**
 * The two gates a guarded command passes through.
 *
 * `createReviewLimiter` bounds how many guardian model calls run at once. The
 * calls are independent requests against one cached reviewer prefix, so
 * running several in parallel costs the same and finishes sooner.
 *
 * `createReviewQueue` is the FIFO *decision* slot: applying a verdict, and
 * asking the user when the verdict is `ask_user`, happen one command at a
 * time. Two approval dialogs fighting over one surface is the thing it exists
 * to prevent, and holding it while a prompt is open is what lets a sibling's
 * verdict notice the user's answer before it is applied. Denies, trusted
 * commands and already-approved execution never enter either.
 *
 * Every acquirer releases in a `finally`, and a release that throws (or is
 * never observed) must not poison later requests — so the tail is always a
 * settled-or-settling promise that swallows rejection.
 *
 * The decision slot spans the human prompt, so its wait is unbounded in
 * wall-clock time: it is cancellable (`acquire(signal)`) and visible (`busy`,
 * which the caller uses to render a "queued" row instead of a blank gap).
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
	/** True while a slot is held, so a caller can show a queued state. */
	readonly busy: boolean;
}

export function createReviewQueue(): ReviewQueue {
	let tail: Promise<void> = Promise.resolve();
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
			try {
				await (signal ? raceAbort(previous, signal) : previous.catch(() => undefined));
			} catch (error) {
				// Keep the chain intact: our slot resolves when the one ahead of us
				// does, so an aborted waiter never lets the next one overtake the live
				// holder. Resolving `release()` here instead would hand the queue to
				// the next waiter while the current holder is still inside its
				// critical section — silently undoing the mutual exclusion this class
				// exists to provide.
				void previous.catch(() => undefined).then(release);
				throw error;
			}
			held += 1;
			return releaseOnce;
		},
		get busy() {
			return held > 0;
		},
	};
}

export interface ReviewLimiter {
	/**
	 * Waits until fewer than `capacity` slots are held, then returns this
	 * slot's release function. Waiters are served in arrival order, each
	 * against the capacity it asked with, so a config change applies to the
	 * next grant rather than revoking live ones.
	 *
	 * Rejects with the signal's reason if `signal` aborts first; an aborted
	 * waiter never takes a slot.
	 */
	acquire(capacity: number, signal?: AbortSignal): Promise<() => void>;
	/** True when an acquire with `capacity` would have to wait. */
	wouldWait(capacity: number): boolean;
}

interface LimiterWaiter {
	capacity: number;
	grant: () => void;
}

export function createReviewLimiter(): ReviewLimiter {
	let held = 0;
	const waiters: LimiterWaiter[] = [];

	function pump(): void {
		while (waiters.length > 0 && held < Math.max(1, waiters[0].capacity)) {
			const next = waiters.shift()!;
			held += 1;
			next.grant();
		}
	}

	function releaser(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			held -= 1;
			pump();
		};
	}

	return {
		acquire(capacity: number, signal?: AbortSignal): Promise<() => void> {
			if (signal?.aborted) return Promise.reject(signal.reason);
			if (waiters.length === 0 && held < Math.max(1, capacity)) {
				held += 1;
				return Promise.resolve(releaser());
			}
			return new Promise<() => void>((resolve, reject) => {
				const onAbort = () => {
					const index = waiters.indexOf(waiter);
					if (index >= 0) waiters.splice(index, 1);
					reject(signal!.reason);
					// The head may have been the one blocking a smaller-capacity waiter.
					pump();
				};
				const waiter: LimiterWaiter = {
					capacity,
					grant: () => {
						signal?.removeEventListener("abort", onAbort);
						resolve(releaser());
					},
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				waiters.push(waiter);
			});
		},
		wouldWait(capacity: number): boolean {
			return waiters.length > 0 || held >= Math.max(1, capacity);
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
