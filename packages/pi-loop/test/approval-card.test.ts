/**
 * The approval card and its action menu.
 *
 * The card is the one artifact planning exists to produce, so what it *is* —
 * a framed custom-type block in the transcript, emitted once — is worth
 * pinning as hard as what it says.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { registerLoopProposeTool } from "../src/propose-tool.js";
import {
	LOOP_PROPOSAL_ENTRY_TYPE,
	registerLoopProposalRenderer,
} from "../src/presentation.js";
import { loopApprovalScreen } from "../src/loop-action-menus.js";
import { buildProposal } from "../src/planning.js";
import { createLoopHarness } from "./support/mock-pi.js";

const DEFAULTS = { intervalMs: 600_000, maxTurns: 25, expiresInMs: 604_800_000 };

async function propose(harness: ReturnType<typeof createLoopHarness>, objective: string) {
	registerLoopProposeTool(harness.pi, harness.controller);
	harness.controller.beginPlanning();
	const tool = harness.tools.get("loop_propose") as {
		execute(
			id: string,
			params: Record<string, unknown>,
			signal: undefined,
			onUpdate: undefined,
			ctx: unknown,
		): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
	};
	return tool.execute("call-1", { objective }, undefined, undefined, harness.ctx);
}

test("the card goes out as a display-only custom entry, not model context or a toast", async () => {
	const harness = createLoopHarness();
	try {
		await propose(
			harness,
			"- ship the thing, verified by npm test passing\n- and document it, verified by a link check",
		);

		const cards = harness.branch.filter(
			(entry) => (entry as { customType?: string }).customType === LOOP_PROPOSAL_ENTRY_TYPE,
		) as Array<{ data?: { markdown?: string } }>;
		assert.equal(cards.length, 1, "the card is emitted exactly once");
		assert.match(String(cards[0]?.data?.markdown), /Loop ready to start/);
		assert.match(String(cards[0]?.data?.markdown), /`c1`  ship the thing/);
		assert.equal(harness.sentMessages.length, 0, "display-only cards never enter model context");

		// The toast is the regression this replaced: a transient line carrying an
		// artifact the user needs to scroll back to.
		for (const notification of harness.notifications) {
			assert.doesNotMatch(notification.message, /Loop ready to start/);
		}
	} finally {
		harness.cleanup();
	}
});

test("the tool result summarises the card instead of repeating it", async () => {
	const harness = createLoopHarness();
	try {
		const result = await propose(harness, "- do a thing, verified by a test\n- and another");
		const text = result.content.map((part) => part.text).join("\n");
		// The objective is already in the model's context; spending it again in a
		// tool result buys nothing and costs the whole card every turn after.
		assert.doesNotMatch(text, /Loop ready to start/);
		assert.match(text, /2 criteria/);
		assert.match(text, /nothing is running yet/i);
	} finally {
		harness.cleanup();
	}
});

test("reopening the approval does not emit a second card for the same draft", async () => {
	const harness = createLoopHarness();
	try {
		await propose(harness, "- one thing, verified by a check");
		// What /loop does when the user reopens the actions.
		harness.controller.showProposalCard(harness.ctx);
		harness.controller.showProposalCard(harness.ctx);
		assert.equal(
			harness.branch.filter(
				(entry) => (entry as { customType?: string }).customType === LOOP_PROPOSAL_ENTRY_TYPE,
			).length,
			1,
		);

		// A re-proposal is a different thing to approve, so it gets its own card.
		harness.controller.propose("- one thing, verified by a check", { intervalMs: 1_800_000 });
		harness.controller.showProposalCard(harness.ctx);
		assert.equal(
			harness.branch.filter(
				(entry) => (entry as { customType?: string }).customType === LOOP_PROPOSAL_ENTRY_TYPE,
			).length,
			2,
		);
	} finally {
		harness.cleanup();
	}
});

test("the card renderer tolerates persisted data it did not write", (t) => {
	// The renderer runs against whatever is on disk: an entry that predates a
	// field, a partial write, a hand-edited session file. Pi contains a throw as
	// an inline `renderer failed:` box, which is survivable but a needlessly
	// ugly way to say "this card is old".
	const harness = createLoopHarness({ mode: "print" });
	t.after(harness.cleanup);
	registerLoopProposalRenderer(harness.pi);
	const render = harness.entryRenderers.get(LOOP_PROPOSAL_ENTRY_TYPE) as (
		entry: { data: unknown },
	) => unknown;
	assert.ok(render, "the renderer is registered");

	// The good path still renders the card body.
	const card = render({ data: { markdown: "# Loop ready", criteria: 2, proposedAt: 0 } });
	assert.ok(card, "valid data renders");

	// Every shape a truncated or foreign entry can take renders the fallback
	// instead of throwing.
	for (const data of [undefined, null, {}, { markdown: 42 }, { markdown: null }, "nope", []]) {
		assert.doesNotThrow(() => render({ data }), `threw on ${JSON.stringify(data) ?? "undefined"}`);
		const fallback = render({ data }) as { text?: string };
		assert.match(
			String(fallback.text ?? fallback),
			/Loop proposal card unavailable/,
			"malformed data renders the fallback line",
		);
	}
});

test("the action menu offers approve, edit and cancel — and a fresh session", () => {
	const screen = loopApprovalScreen(buildProposal("- do a\n- do b", DEFAULTS, 0));
	const items = screen.items.map((item) => item.id);
	assert.deepEqual(items, [
		"start-here",
		"start-fresh",
		"change-cadence",
		"keep-editing",
		"cancel",
	]);
	// Every entry carries a description: "start in a fresh session" is not
	// self-explanatory, and a bare ui.select of labels could not say what it
	// means.
	for (const item of screen.items) {
		assert.ok(item.description, `${item.id} has no description`);
	}
	assert.match(screen.lines?.join("\n") ?? "", /2 criteria/);
});
