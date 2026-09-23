import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { existsSync, readFileSync, statSync, truncateSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendDenialRecord,
	buildDenialRecord,
	readRecentDenials,
	type DenialRecord,
} from "../denial-log.ts";
import { SIDECAR_ROTATE_BYTES } from "../jsonl-sidecar.ts";
import { scratchDir } from "./support/temp-dir.ts";

function tempPath(): string {
	return join(scratchDir("pi-ap-denials-"), "denials.jsonl");
}

function record(command: string, verdict: DenialRecord["verdict"] = "block"): DenialRecord {
	return buildDenialRecord({
		sessionId: "s1",
		cwd: "/work",
		tool: "bash",
		gate: { label: "Force push", group: "git" },
		command,
		verdict,
		reason: "history rewrite was not requested",
		decisionSource: "guardian",
	});
}

describe("denial log", () => {
	test("builds a complete v1 record", () => {
		const built = record("git push --force origin main");
		assert.equal(built.v, 1);
		assert.ok(built.id.length > 0);
		assert.ok(!Number.isNaN(Date.parse(built.ts)));
		assert.equal(built.command, "git push --force origin main");
		assert.equal(built.verdict, "block");
		assert.equal(built.decisionSource, "guardian");
		assert.deepEqual(built.gate, { label: "Force push", group: "git" });
	});

	test("appends privately and reads back newest first with a limit", () => {
		const path = tempPath();
		for (let index = 0; index < 5; index++) appendDenialRecord(path, record(`cmd-${index}`));

		assert.equal(statSync(path).mode & 0o777, 0o600);
		const recent = readRecentDenials(path, 3);
		assert.deepEqual(recent.map((entry) => entry.command), ["cmd-4", "cmd-3", "cmd-2"]);
	});

	test("a missing file is an empty history and malformed lines are skipped", () => {
		assert.deepEqual(readRecentDenials(join(tmpdir(), "does-not-exist.jsonl"), 10), []);

		const path = tempPath();
		appendDenialRecord(path, record("real-command"));
		appendFileSync(path, "not json\n{\"v\":2,\"command\":42}\n", "utf8");
		appendDenialRecord(path, record("another-real-command", "revise"));

		const recent = readRecentDenials(path, 10);
		assert.deepEqual(recent.map((entry) => entry.command), ["another-real-command", "real-command"]);
		assert.equal(recent[0].verdict, "revise");
	});

	test("only well-shaped v1 records are returned", () => {
		const path = tempPath();
		writeFileSync(path, `${JSON.stringify({ v: 1, command: "x" })}\n`, "utf8");
		assert.deepEqual(readRecentDenials(path, 10), []);
	});

	test("rotates one generation once the sidecar reaches the cap", () => {
		const path = tempPath();
		writeFileSync(path, "");
		truncateSync(path, SIDECAR_ROTATE_BYTES);
		const denial = record("after-rotation");
		appendDenialRecord(path, denial);

		assert.ok(existsSync(`${path}.1`), "previous generation is retained");
		const lines = readFileSync(path, "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		assert.deepEqual(JSON.parse(lines[0]!) as DenialRecord, denial);
	});
});
