/**
 * `loop_wait`: the loop's adaptive wake.
 *
 * Without it a loop has exactly one answer to "progress depends on something
 * outside this session": keep continuing, and burn turns re-checking. With
 * it, the model says what it is waiting for and roughly how long, the loop
 * stops continuing on its own, and the wait's deadline becomes the next thing
 * that speaks.
 *
 * Registered unconditionally, like `loop_complete`, and for the same reason:
 * tools are part of the cached request prefix, so adding or removing one
 * mid-session invalidates the whole conversation cache. It refuses when no
 * loop is active.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LoopController } from "./loop.js";
import { formatDuration } from "./interval.js";
import { MAX_WAIT_DELAY_MS, MAX_WAIT_REASON_LENGTH, MIN_WAIT_DELAY_MS } from "./wait.js";

export const LOOP_WAIT_TOOL = "loop_wait";

export function registerLoopWaitTool(pi: ExtensionAPI, controller: LoopController) {
	pi.registerTool(
		defineTool({
			name: LOOP_WAIT_TOOL,
			label: "Loop Wait",
			description:
				"Pause the active /loop's automatic continuations while progress depends on an external event. The loop stays active; it simply stops continuing on its own until resume_after_ms elapses or something else wakes the session. Never use it for ordinary unfinished work.",
			promptSnippet: "Wait for an external event without ending the active /loop",
			promptGuidelines: [
				"Call loop_wait only when progress genuinely depends on a later external event (a CI run, a deploy, a human reply), never for ordinary unfinished work and never as a way to end a turn early.",
				"Give a one-sentence reason: it is shown in the loop widget and status, and it is the only record of what the loop was waiting for.",
				"Never poll for work Pi already notifies you about — background processes, subagents, and tool completions wake the session on their own.",
				// The cache-window guidance: a wake just after the provider's
				// prompt-cache TTL pays a full cache miss for nothing.
				"Avoid resume_after_ms near 300000 (5 minutes): that is the prompt-cache dead zone, where the cache has just expired and the next turn re-reads the whole conversation at full price.",
				"Use a value at or below 270000 only when actively polling external state that nothing else will report. Otherwise commit to 1200000 or more.",
				`resume_after_ms is clamped to [${MIN_WAIT_DELAY_MS}, ${MAX_WAIT_DELAY_MS}]; the clamped value is echoed back. Omitting it waits until something else wakes the session.`,
				"Call loop_wait alone: sibling tool calls in the same turn can prevent the turn from ending, which is the point of the wait.",
			],
			parameters: Type.Object({
				reason: Type.String({
					minLength: 1,
					maxLength: MAX_WAIT_REASON_LENGTH,
					description:
						"One sentence naming the external event being waited for. Shown in the loop widget and status.",
				}),
				resume_after_ms: Type.Optional(
					Type.Number({
						description:
							"Optional bounded safety wake-up in milliseconds, clamped to [60000, 3600000]. Omit to wait until something else wakes the session.",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const loop = controller.state;
				if (!loop || loop.objective === undefined) {
					return {
						content: toolContent(
							"No /loop with an objective is active, so there is nothing to wait on. Run /loop to plan and approve one.",
						),
						details: {},
						isError: true,
					};
				}
				if (loop.status !== "active") {
					return {
						content: toolContent(`The /loop is ${loop.status}; there is nothing to wait on.`),
						details: { loopId: loop.id, status: loop.status },
						isError: true,
					};
				}
				const reason = params.reason.trim();
				if (!reason) {
					return {
						content: toolContent("loop_wait needs a reason: name the external event in one sentence."),
						details: { loopId: loop.id },
						isError: true,
					};
				}
				const wait = controller.enterWait(reason, params.resume_after_ms);
				if (!wait) {
					return {
						content: toolContent("The /loop could not enter a wait; it is no longer active."),
						details: { loopId: loop.id },
						isError: true,
					};
				}
				const deadline =
					wait.effectiveMs === undefined
						? "No deadline: the loop stays quiet until something else wakes the session."
						: `${wait.clamped ? `Requested ${Math.round((wait.requestedMs ?? 0) / 1000)}s, clamped to ` : "Waking in "}${formatDuration(wait.effectiveMs)}.`;
				return {
					content: toolContent(
						`Loop waiting: ${reason}\n${deadline} Automatic continuations are held; the loop stays active.`,
					),
					details: {
						loopId: loop.id,
						reason,
						...(wait.requestedMs === undefined ? {} : { requestedMs: wait.requestedMs }),
						...(wait.effectiveMs === undefined ? {} : { effectiveMs: wait.effectiveMs }),
						clamped: wait.clamped,
					},
				};
			},
		}),
	);
}

function toolContent(text: string) {
	return [{ type: "text" as const, text }];
}
