/**
 * pi-loop: Claude-Code-/loop-inspired long-running work for Pi. A loop
 * carries its own objective and completion criteria, is paced by the session
 * settling, keeps a durable ledger, compacts itself, and ends through
 * `loop_complete`, a cap, its expiry, or the user. It depends on no other
 * extension; the only sibling state it reads is pi-plan-mode's, fail-open, so
 * a loop never injects into a planning conversation.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseLoopCommand } from "./command.js";
import { registerLoopCompleteTool } from "./complete-tool.js";
import { registerLoopProgressTool } from "./progress-tool.js";
import { registerLoopProposeTool } from "./propose-tool.js";
import { registerLoopProposalRenderer } from "./presentation.js";
import { LOOP_PLANNING_HINT } from "./planning.js";
import { registerLoopWaitTool } from "./wait-tool.js";
import { LoopController, type LoopControllerOptions } from "./loop.js";
import {
	showLoopApproval,
	showLoopLaunch,
	showLoopManager,
	showLoopPlanning,
} from "./manager.js";
import { buildLoopObjectivePrompt } from "./objective.js";
import { registerLoopMessageRendering } from "./render.js";
import { readPlanModeEnabled } from "./state.js";

/** What the planning menu's "Request proposal now" asks for. */
export const REQUEST_PROPOSAL_MESSAGE =
	"Put the loop we have been drafting up for approval now: call loop_propose with the objective as an acceptance test, one requirement per bullet naming the check that proves it, plus any ground rules we agreed. If something material is still undecided, ask me that one question instead.";

export default function loop(pi: ExtensionAPI, options: LoopControllerOptions = {}) {
	const controller = new LoopController(pi, options);
	const proposeTools = ["loop_propose"];
	const runtimeTools = ["loop_complete", "loop_progress", "loop_wait"];
	let proposeActivated = false;
	let runtimeActivated = false;
	const reconcileTools = () => {
		const active = pi.getActiveTools();
		const wanted = new Set(active);
		for (const name of proposeTools) proposeActivated ? wanted.add(name) : wanted.delete(name);
		for (const name of runtimeTools) runtimeActivated ? wanted.add(name) : wanted.delete(name);
		const next = [...wanted];
		if (next.length !== active.length || next.some((name, index) => name !== active[index])) {
			pi.setActiveTools(next);
		}
	};
	const activatePropose = () => {
		proposeActivated = true;
		reconcileTools();
	};
	const activateRuntime = () => {
		runtimeActivated = true;
		reconcileTools();
	};

	registerLoopCompleteTool(pi, controller);
	registerLoopWaitTool(pi, controller);
	registerLoopProgressTool(pi, controller);
	registerLoopProposeTool(pi, controller, activateRuntime);
	registerLoopProposalRenderer(pi);
	// Narrowing happens at session_start, never here: Pi refuses action methods
	// (getActiveTools/setActiveTools among them) during extension loading.
	// Collapse loop pokes into one-line transcript chips (display-only; the
	// stored message and model context are untouched).
	registerLoopMessageRendering(pi);

	/**
	 * Send a user message on the user's behalf, exactly the way pi-plan-mode
	 * seeds a planning conversation: an idle session takes it now, a busy one
	 * takes it as a follow-up rather than steering the turn in flight.
	 */
	const sendPlanningMessage = (text: string, ctx: ExtensionCommandContext): void => {
		try {
			if (ctx.isIdle()) pi.sendUserMessage(text);
			else pi.sendUserMessage(text, { deliverAs: "followUp" });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Unable to send the loop planning message: ${detail}`, "error");
		}
	};

	const beginPlanning = (ctx: ExtensionCommandContext): void => {
		if (controller.planning.active) return;
		activatePropose();
		controller.beginPlanning();
		ctx.ui.notify(
			"Loop planning. Describe what you want the loop to achieve and how you will know it is done; the agent drafts it and puts it up for approval. Nothing starts until you approve it.",
			"info",
		);
	};

	pi.registerCommand("loop", {
		description: "Plan, approve, and manage a long-running loop: /loop [what it should achieve]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const command = parseLoopCommand(args);
			const running = controller.state !== undefined && controller.state.status !== "stopped";
			// `/loop <text>` mirrors `/plan <prompt>`: it opens planning and says the
			// first thing. A loop already running owns the session, so the text goes
			// nowhere and the manager opens instead of a second draft.
			if (command.kind === "seed") {
				if (running) {
					ctx.ui.notify(
						"A loop is already running in this session. Stop it from this menu before planning another.",
						"warning",
					);
					await showLoopManager(controller, ctx);
					return;
				}
				beginPlanning(ctx);
				sendPlanningMessage(command.text, ctx);
				return;
			}
			// Bare /loop is the front door, and which door it opens is the state:
			// manager, approval card, planning menu, or launch menu.
			if (running) {
				await showLoopManager(controller, ctx);
				return;
			}
			if (controller.planning.proposal) {
				await showLoopApproval(controller, ctx);
				return;
			}
			if (controller.planning.active) {
				await showLoopPlanning(controller, ctx, {
					requestProposal: () => sendPlanningMessage(REQUEST_PROPOSAL_MESSAGE, ctx),
				});
				return;
			}
			await showLoopLaunch(controller, ctx, () => beginPlanning(ctx));
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		proposeActivated = false;
		runtimeActivated = false;
		controller.onSessionStart(ctx);
		if (controller.state?.status === "active") activateRuntime();
		else reconcileTools();
	});
	pi.on("session_shutdown", async () => {
		controller.onSessionShutdown();
	});
	// The pacemaker: agent_end records the intent to continue, agent_settled
	// delivers it once Pi will accept a message.
	pi.on("agent_start", async (_event, ctx) => {
		controller.onAgentStart(ctx);
	});
	pi.on("agent_end", async (event, ctx) => {
		controller.onAgentEnd(ctx, event.messages ?? []);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		controller.onAgentSettled(ctx);
	});
	// A loop carries its own objective and injects it as a byte-stable system
	// append, which is what lets the poke and continuation messages stay
	// pointer-sized.
	pi.on("before_agent_start", (event, ctx) => {
		// Self-heal the runtime tool set every turn an active loop takes, not just
		// at session_start. `resumeLoop` flips a restored *paused* loop to active
		// and dispatches a continuation from the /loop menu, which has no way to
		// reach activateRuntime — so without this the resumed loop would run with
		// loop_complete stripped, be told by its own objective append to call it,
		// and then be re-paused by enforceToolAvailability blaming --tools for
		// something this extension did to itself. Activation is monotonic, so this
		// covers resumeAfterEdit and the fresh-session handoff too, and costs a
		// no-op set comparison on every other turn.
		if (controller.state?.status === "active") activateRuntime();
		// Plan mode owns the prompt while active. Loop scheduling is already held
		// by the same persisted state; suppressing the append removes the remaining
		// mixed-workflow instruction surface.
		if (readPlanModeEnabled(ctx.sessionManager.getBranch())) return;
		// Planning precedes any loop, so its guidance is injected on the same hook
		// and is mutually exclusive with the objective append below.
		if (controller.planning.active) {
			return { systemPrompt: `${event.systemPrompt}\n\n${LOOP_PLANNING_HINT}` };
		}
		const loop = controller.state;
		if (!loop || loop.status !== "active") return;
		const objectivePrompt = buildLoopObjectivePrompt(loop, controller.ledger);
		if (objectivePrompt === undefined) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${objectivePrompt}` };
	});

	// Pi ignores the return value; a test uses it. The controller *is* the
	// extension's state, and a test holding a different instance of it would
	// quietly assert against a loop nobody is running.
	return controller;
}
