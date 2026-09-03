/**
 * Tool registration and execution for `ask_user_question`.
 *
 * The tool name is preserved verbatim from
 * @juicesharp/rpiv-ask-user-question so session history recorded against that
 * package replays cleanly. Only one of the two may be installed at a time.
 */

import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	ASK_USER_BLOCKED_EVENT,
	ASK_USER_PROMPT_EVENT,
	type AskUserBlockedEventPayload,
	type AskUserPromptEventPayload,
} from "./events.ts";
import { QuestionnaireSession } from "./questionnaire.ts";
import { buildResponse, buildToolResult } from "./tool/envelope.ts";
import {
	type AskUserParams,
	type QuestionnaireResult,
	QuestionParamsSchema,
	TOOL_NAME,
} from "./tool/schema.ts";
import { validateParams } from "./tool/validate.ts";
import { QuestionnaireDialog } from "./view/dialog.ts";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

/**
 * Wording matters here. Without the explicit "do NOT treat this as a decline",
 * models read a host limitation as a refusal and change course as though the
 * user had said no. Inherited from rpiv-ask-user-question, which learned it
 * the hard way.
 */
const ERROR_NO_CUSTOM_UI =
	"Error: this client cannot render the questionnaire (custom UI is unavailable). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool.";

const DESCRIPTION = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Preview feature:
Use the optional \`preview\` field on an option when presenting a concrete artifact the user needs to compare visually: an ASCII mockup, a code snippet, a diagram or configuration variation. It renders as markdown in a pane below the options while that option is highlighted. Do not use it for simple preference questions where the label and description already say enough.

Multi-select:
Set \`multiSelect: true\` on a question when several answers can hold at once — "which of these packages should change", "which checks to run before merging". Keep mutually exclusive choices single-select; that is still the default and the common case. A multi-select question may have 2-6 options instead of 2-4, renders as checkboxes, and the user toggles rows with Space or a digit and confirms with Enter. The answer comes back as the chosen labels joined with ", ", and the user may add a typed value to the checked ones through the "Type something." row. \`preview\` works on multi-select options too.

Usage notes:
- The user can pick an option with the number keys, type a custom answer via the automatically appended "Type something." row, attach a note to their choice by pressing n, or press Esc to decline. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- If you recommend a specific option, make it the first option and add "(Recommended)" at the end of the label.
- Ask 1-4 questions per call, each with 2-4 options (2-6 when \`multiSelect\` is true). Multiple questions render as tabs the user cycles with Tab; every question must be answered before the call returns. Group questions that belong to one decision rather than asking them in separate calls, but do not pad a single decision into several questions.`;

function emitPrompt(pi: ExtensionAPI, params: AskUserParams): void {
	const payload: AskUserPromptEventPayload = {
		questions: params.questions.map((q) => ({
			question: q.question,
			header: q.header,
			// Emitted only when true — append-only payload policy (events.ts).
			...(q.multiSelect ? { multiSelect: true } : {}),
			options: q.options.map((o) => ({ label: o.label, description: o.description })),
		})),
	};
	pi.events.emit(ASK_USER_PROMPT_EVENT, payload);
}

function emitBlocked(pi: ExtensionAPI, active: boolean): void {
	const payload: AskUserBlockedEventPayload = { active };
	pi.events.emit(ASK_USER_BLOCKED_EVENT, payload);
}

export function registerTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Ask User Question",
		description: DESCRIPTION,
		parameters: QuestionParamsSchema,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const typed = params as unknown as AskUserParams;

			// Backstop only — reconcile.ts should already have stripped the tool
			// in headless runs (subagent children must never block on a human).
			if (!ctx.hasUI) {
				return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });
			}

			const invalid = validateParams(typed);
			if (invalid) {
				return buildToolResult(`Error: ${invalid.message}`, {
					answers: [],
					cancelled: true,
					error: "invalid_params",
				});
			}

			const session = new QuestionnaireSession(typed);
			if (signal?.aborted) return buildResponse(session.cancelledResult(), typed);

			let dialog: QuestionnaireDialog | undefined;
			const cancel = () => dialog?.cancel();
			signal?.addEventListener("abort", cancel, { once: true });
			emitPrompt(pi, typed);
			emitBlocked(pi, true);
			try {
				// NOT an overlay. An overlay is composited over the bottom rows of the
				// viewport, so the transcript underneath it is unreachable: the user is
				// already scrolled to the bottom and there is nothing left to scroll.
				// Rendering in the editor area instead puts the dialog in the normal
				// document flow — the transcript is pushed up rather than covered, and
				// every line of it stays reachable in the terminal's own scrollback.
				//
				// This is also where `ctx.ui.select` renders, and where
				// pi-auto-permissions' approval prompt already puts `OptionSelector`.
				// pi restores the input editor when `done` fires.
				const result = await ctx.ui.custom<QuestionnaireResult | null>(
					(tui, theme, _keybindings, done) => {
						dialog = new QuestionnaireDialog({
							session,
							theme,
							// Reuse pi's own markdown theme so previews match the
							// transcript rather than inventing a second code style.
							markdownTheme: getMarkdownTheme(),
							done,
							requestRender: () => tui.requestRender(),
						});
						if (signal?.aborted) queueMicrotask(() => dialog?.cancel());
						return dialog;
					},
				);

				// `custom()` resolving undefined means the host reported hasUI but
				// cannot actually render a custom component. The user saw nothing.
				if (result === undefined) {
					return buildToolResult(ERROR_NO_CUSTOM_UI, {
						answers: [],
						cancelled: true,
						error: "no_custom_ui",
					});
				}
				return buildResponse(result, typed);
			} finally {
				signal?.removeEventListener("abort", cancel);
				// In `finally` so listeners are never left believing we are still
				// blocked on a human after a throw.
				emitBlocked(pi, false);
			}
		},
	});
}
