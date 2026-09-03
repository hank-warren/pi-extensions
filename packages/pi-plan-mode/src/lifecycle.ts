/**
 * A scope captured when deferred work starts: the signal that work should race
 * against, and the question "is what I was started for still the current
 * thing?".
 */
export interface LifecycleScope {
	readonly signal: AbortSignal;
	isCurrent(): boolean;
}

/**
 * Two nested generations decide whether deferred Plan-mode work may still act.
 *
 * The session generation moves when Pi replaces or shuts down the session: a
 * menu, a settings reload, or a question left waiting from the previous session
 * must never write to the new one. The workflow generation moves on every
 * enter/exit/implement, so a menu opened against one plan cannot act after the
 * user has moved on — while a settings reload, which belongs to the session
 * rather than to a plan, is deliberately left alone by it.
 *
 * The abort signal is the second half of the same rule: it stops work that is
 * already blocked on the UI, where a generation check would never be reached.
 */
export function createLifecycle() {
	let sessionGeneration = 0;
	let workflowGeneration = 0;
	let controller = new AbortController();

	const sessionScope = (): LifecycleScope => {
		const session = sessionGeneration;
		const active = controller;
		return {
			signal: active.signal,
			isCurrent: () => session === sessionGeneration && !active.signal.aborted,
		};
	};

	/**
	 * Ends the current session: everything captured before this call goes stale
	 * and everything waiting on the signal is aborted with `reason`. The aborted
	 * signal stays in place, so anything captured *after* it is stale too —
	 * which is what a shut-down session wants: there is no next session to be
	 * current for, and a menu opened in that window must refuse to run.
	 */
	const endSession = (reason: string) => {
		sessionGeneration += 1;
		controller.abort(new DOMException(reason, "AbortError"));
	};

	return {
		/** The live session signal, for composing with a caller's own. */
		get signal() {
			return controller.signal;
		},
		endSession,
		/**
		 * Ends the current session and opens the next one, whose scope is
		 * returned: work started from here races against a fresh signal.
		 */
		nextSession(reason: string): LifecycleScope {
			endSession(reason);
			controller = new AbortController();
			return sessionScope();
		},
		/** Supersedes menus and prompts opened against the previous plan state. */
		nextWorkflow() {
			workflowGeneration += 1;
		},
		/** The scope for menu-scale work: stale as soon as either generation moves. */
		capture(): LifecycleScope {
			const session = sessionScope();
			const workflow = workflowGeneration;
			return {
				signal: session.signal,
				isCurrent: () => session.isCurrent() && workflow === workflowGeneration,
			};
		},
	};
}
