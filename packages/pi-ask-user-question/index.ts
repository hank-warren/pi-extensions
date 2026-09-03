/**
 * pi-ask-user-question — a structured questionnaire the model can put to you
 * when it would otherwise guess.
 *
 * Numbered options, digit hotkeys and Tab-to-comment come from the shared
 * `OptionSelector` in @hank-warren/pi-permission-selector, composed through
 * `ctx.ui.custom()`. No pi internals are patched.
 *
 * The tool is stripped from the active tool set whenever `ctx.hasUI` is false,
 * so headless subagent children can never block waiting on a human. See
 * reconcile.ts.
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTool } from "./ask-user-question.ts";
import { registerReconciler } from "./reconcile.ts";

export {
	ASK_USER_AVAILABILITY_EVENT,
	ASK_USER_BLOCKED_EVENT,
	ASK_USER_PROMPT_EVENT,
	type AskUserAvailabilityEventPayload,
	type AskUserBlockedEventPayload,
	type AskUserPromptEventPayload,
	type AskUserPromptOption,
	type AskUserPromptQuestion,
} from "./events.ts";

export default function askUserQuestionExtension(pi: ExtensionAPI): void {
	registerTool(pi);
	// Our own location, resolved without touching a runtime action method:
	// nothing on `pi` may be *called* during extension loading.
	registerReconciler(pi, fileURLToPath(import.meta.url));
}
