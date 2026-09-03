/**
 * `loop_progress`: the only supported write path into the loop ledger.
 *
 * The ledger is the one thing that survives compaction, and until this tool
 * existed the model was told to maintain it with no way to do so — so it
 * reached for `write` or a shell heredoc, and a single `cat > PROGRESS.md`
 * replaced the objective line, the other three sections, and days of
 * failed-approach notes. `createLedger` opens that file with `flag: "wx"`
 * precisely so the *engine* can never do that; leaving the *agent* a path that
 * can made the protection decorative.
 *
 * Two operations, deliberately in one tool: record a note in a named section,
 * and flip a criterion with the citation that justified it. They travel
 * together — "here is what I did, and here is the criterion it proves" is one
 * thought, and one tool call per turn keeps the ledger current without a
 * second round trip.
 *
 * Registered unconditionally like `loop_complete` and `loop_wait`: tools are
 * part of the cached request prefix, so adding one mid-session would
 * invalidate the whole conversation cache. It refuses when no loop is active.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	MAX_EVIDENCE_LENGTH,
	MAX_PROGRESS_TEXT_LENGTH,
	markCriterion,
	PROGRESS_SECTIONS,
	type ProgressSection,
	writeProgressSection,
} from "./ledger.js";
import type { LoopController } from "./loop.js";

const LOOP_PROGRESS_TOOL = "loop_progress";

export function registerLoopProgressTool(pi: ExtensionAPI, controller: LoopController) {
	pi.registerTool(
		defineTool({
			name: LOOP_PROGRESS_TOOL,
			label: "Loop Progress",
			description:
				"Record progress in the active /loop's durable ledger: append a note to one PROGRESS.md section, and/or mark a completion criterion met with the evidence that proves it. The only supported way to write to the ledger — never edit PROGRESS.md or criteria.json with file or shell tools.",
			promptSnippet: "Record loop progress and mark criteria met with evidence",
			promptGuidelines: [
				"Use loop_progress to update the loop ledger. Never write PROGRESS.md or criteria.json with the file or shell tools: a whole-file write destroys the objective line and the other sections, and hand-editing criteria.json bypasses the rule that only `passes` may change.",
				"Record a note the same turn you learn something, not at the end. The failed-approaches section carries the most value, because it is the only thing that stops the next continuation from re-running an experiment that already failed.",
				"'current status' replaces what is there (it is one current value); the other three sections append.",
				"Mark a criterion met only with authoritative evidence: the command and what it printed, the file and what it now contains, the URL and its state. The citation is stored next to the criterion and is what loop_complete answers for later.",
			],
			parameters: Type.Object({
				section: Type.Optional(
					StringEnum([...PROGRESS_SECTIONS], {
						description:
							"Which PROGRESS.md section to write. 'current status' replaces its contents; the others append.",
					}),
				),
				note: Type.Optional(
					Type.String({
						maxLength: MAX_PROGRESS_TEXT_LENGTH,
						description:
							"Markdown to record in that section. Write list sections as '- ' bullets to match the file.",
					}),
				),
				criterion: Type.Optional(
					Type.String({
						maxLength: 40,
						description: "Criterion id to mark, e.g. 'c2'. Ids come from the loop's criteria.json.",
					}),
				),
				evidence: Type.Optional(
					Type.String({
						maxLength: MAX_EVIDENCE_LENGTH,
						description:
							"The citation proving that criterion: the command and its output, the file and its contents, the URL and its state. Required when marking one met.",
					}),
				),
				met: Type.Optional(
					Type.Boolean({
						description:
							"Whether the criterion is met. Defaults to true; pass false to retract a criterion marked met in error.",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const loop = controller.state;
				if (!loop || loop.objective === undefined) {
					return failure(
						"No /loop with an objective is active, so there is no ledger to write. Run /loop to plan and approve one.",
					);
				}
				const paths = controller.ledger;
				if (!paths) {
					return failure(
						"This loop has no ledger (it could not be created), so progress cannot be recorded. Keep the state in your reply instead.",
					);
				}

				const section = params.section as ProgressSection | undefined;
				const note = params.note?.trim();
				const criterion = params.criterion?.trim();
				// A tool call that writes nothing is a mistake worth naming: the
				// model believed it recorded something and it did not.
				if (!note && !criterion) {
					return failure(
						"Nothing to record. Pass section + note to write a ledger entry, criterion + evidence to mark a criterion, or both.",
					);
				}
				if (note && !section) return failure("A note needs a section to write it to.");
				if (section && !note) return failure("A section needs a note to write into it.");

				const done: string[] = [];
				if (section && note) {
					const failed = writeProgressSection(paths, section, note);
					if (failed) return failure(`Could not write the ledger: ${failed}`);
					done.push(`Recorded under "${section}".`);
				}

				let remaining: string | undefined;
				if (criterion) {
					const met = params.met ?? true;
					const result = markCriterion(paths, criterion, params.evidence ?? "", met, Date.now());
					if (!result.ok) {
						// A half-applied call still reports the half that landed, so the
						// model does not record the note twice on the retry.
						return failure(
							[...done, `Could not mark ${criterion}: ${result.message}`].join(" "),
							done.length > 0,
						);
					}
					done.push(result.message);
					const unmet = (result.criteria ?? []).filter((entry) => !entry.passes);
					remaining =
						unmet.length > 0
							? `Still unmet: ${unmet.map((entry) => entry.id).join(", ")}.`
							: "Every criterion is now marked met; audit them against authoritative current state before calling loop_complete.";
					controller.updateWidget();
				}

				return {
					content: [
						{ type: "text" as const, text: [...done, remaining].filter(Boolean).join(" ") },
					],
					details: {
						loopId: loop.id,
						...(section && note ? { section } : {}),
						...(criterion ? { criterion, met: params.met ?? true } : {}),
					},
				};
			},
		}),
	);
}

function failure(text: string, partial = false) {
	return {
		content: [{ type: "text" as const, text }],
		details: { partial },
		isError: true,
	};
}
