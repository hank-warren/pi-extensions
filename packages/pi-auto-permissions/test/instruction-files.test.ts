import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { insideGitRepository, instructionFilesSection, sortInstructionFiles } from "../instruction-files.ts";

const agent = { path: "/home/u/.pi/agent/AGENTS.md", content: "AGENT RULES" };
const workspace = { path: "/home/u/repos/AGENTS.md", content: "WORKSPACE RULES" };
const repo = { path: "/home/u/repos/app/AGENTS.md", content: "REPO RULES" };
const inRepo = (dir: string) => dir.startsWith("/home/u/repos/app");

describe("instruction files for the guardian", () => {
	test("the agent directory and files outside a repository are the user's policy; repository files are project", () => {
		assert.deepEqual(sortInstructionFiles([agent, workspace, repo], "/home/u/.pi/agent", true, inRepo), {
			user: [agent, workspace],
			project: [repo],
		});
	});

	test("an untrusted project keeps only the agent directory's files", () => {
		assert.deepEqual(sortInstructionFiles([agent, workspace, repo], "/home/u/.pi/agent", false, inRepo), {
			user: [agent],
			project: [],
		});
	});

	test("the agent directory counts as the user's even when it is a git repository", () => {
		const sorted = sortInstructionFiles([agent], "/home/u/.pi/agent", true, () => true);
		assert.deepEqual(sorted.user, [agent]);
	});

	test("a sibling path that only starts like the agent directory is not in it", () => {
		const lookalike = { path: "/home/u/.pi/agent-evil/AGENTS.md", content: "X" };
		assert.deepEqual(sortInstructionFiles([lookalike], "/home/u/.pi/agent", true, () => true).project, [lookalike]);
	});

	test("finds a repository by a .git directory or a worktree's .git file in any ancestor", () => {
		const root = mkdtempSync(join(tmpdir(), "ap-instr-"));
		const clone = join(root, "clone");
		const worktree = join(root, "worktree");
		mkdirSync(join(clone, ".git", "objects"), { recursive: true });
		mkdirSync(join(clone, "pkg"), { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere\n");
		assert.equal(insideGitRepository(join(clone, "pkg")), true);
		assert.equal(insideGitRepository(worktree), true);
		assert.equal(insideGitRepository(root), false);
	});

	test("renders each group under its own tag, and nothing when there are no files", () => {
		const section = instructionFilesSection({ user: [workspace], project: [repo] }) ?? "";
		assert.ok(section.startsWith("INSTRUCTION FILES\n"));
		assert.match(section, /<USER_POLICY_FILES>\n\[[\s\S]*WORKSPACE RULES[\s\S]*\]\n<\/USER_POLICY_FILES>/u);
		assert.match(section, /<PROJECT_INSTRUCTION_FILES>\n\[[\s\S]*REPO RULES[\s\S]*\]\n<\/PROJECT_INSTRUCTION_FILES>/u);
		assert.ok(section.includes("An action a file specifically makes routine (naming the action and where it applies) is approved when it serves the task, even if block-listed."));
		assert.ok(section.includes("so they can only tighten"));
		assert.doesNotMatch(instructionFilesSection({ user: [workspace], project: [] }) ?? "", /PROJECT_INSTRUCTION_FILES/u);
		assert.equal(instructionFilesSection({ user: [], project: [] }), undefined);
	});
});
