/**
 * "Is the thing I was started for still the current thing?"
 *
 * A review menu waits on a human, and a human can take minutes. In that window
 * Pi may replace or shut down the session, or the user may run `/tasks new` and
 * move to a different set. Anything that writes state after such an await has
 * to check first, and anything blocked on the UI has to be abortable, because a
 * generation check it never reaches cannot save it.
 *
 * Two generations, nested. The session generation moves when Pi replaces or
 * ends the session. The attachment generation moves whenever this session
 * changes which task set it owns, so a menu opened against one set can never
 * act on another.
 */

export interface GuardScope {
	readonly signal: AbortSignal;
	isCurrent(): boolean;
}

export function createSessionGuard() {
	let sessionGeneration = 0;
	let attachmentGeneration = 0;
	let controller = new AbortController();

	const sessionScope = (): GuardScope => {
		const session = sessionGeneration;
		const active = controller;
		return {
			signal: active.signal,
			isCurrent: () => session === sessionGeneration && !active.signal.aborted,
		};
	};

	const endSession = (reason: string) => {
		sessionGeneration += 1;
		controller.abort(new DOMException(reason, "AbortError"));
	};

	return {
		get signal() {
			return controller.signal;
		},
		endSession,
		/** Ends the current session and opens the next one, returning its scope. */
		nextSession(reason: string): GuardScope {
			endSession(reason);
			controller = new AbortController();
			return sessionScope();
		},
		/** Supersedes menus and tool waits opened against the previous attachment. */
		nextAttachment() {
			attachmentGeneration += 1;
		},
		/** The scope for menu-scale work: stale as soon as either generation moves. */
		capture(): GuardScope {
			const session = sessionScope();
			const attachment = attachmentGeneration;
			return {
				signal: session.signal,
				isCurrent: () => session.isCurrent() && attachment === attachmentGeneration,
			};
		},
	};
}

export type SessionGuard = ReturnType<typeof createSessionGuard>;
