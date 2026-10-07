import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { OptionSelector } from "@hank-warren/pi-permission-selector/selector.ts";
import { ApprovalPrompt, type ApprovalPromptContent, approvalPromptText, noteYellow } from "../approval-prompt.js";

const PLAIN_THEME = { fg: (_role: string, text: string) => text, bold: (text: string) => text };

function build(
  command: string,
  rows: number,
  onSelect: (value: string) => void = () => {},
  appearance?: string,
  inTranscript = true,
) {
  const content: ApprovalPromptContent = {
    header: "Git push — Auto Permissions needs approval",
    command,
    noteLabel: "Guardian",
    note: "force push rewrites history",
    inTranscript,
  };
  const selector = new OptionSelector({
    options: ["Allow", "Block"].map((value) => ({ value, label: value })),
    theme: PLAIN_THEME,
    onSelect: (option) => onSelect(option.value),
  });
  return new ApprovalPrompt({
    content,
    selector,
    theme: { ...PLAIN_THEME, appearance },
    terminalRows: () => rows,
    requestRender: () => {},
  });
}

const CTRL_O = "\x0f";
const SHIFT_DOWN = "\x1b[1;2B";
const wheel = (wheelDelta: number) => ({ type: "wheel", wheelDelta });

const longCommand = Array.from({ length: 100 }, (_, i) => `echo line ${i + 1}`).join("\n");
// eslint-disable-next-line no-control-regex
const strip = (lines: string[]) => lines.map((line) => line.replace(CURSOR_MARKER, "").replace(/\x1b\[[0-9;]*m/gu, ""));
const has = (lines: string[], needle: string) => lines.some((line) => line.includes(needle));

describe("ApprovalPrompt", () => {
  it("orders header, command, guardian note, then options", () => {
    const lines = strip(build("git push --force", 40).render(80));
    const at = (needle: string) => lines.findIndex((line) => line.includes(needle));
    assert.ok(at("needs approval") < at("git push --force"));
    assert.ok(at("git push --force") < at("Guardian: force push rewrites history"));
    assert.ok(at("Guardian:") < at("1. Allow"));
    assert.match(lines[at("Guardian:")]!, /^▌ /u, "the note carries its own marker");
  });

  it("draws the note in a fixed strong yellow, darker on light themes", () => {
    const dark = build("ls", 40).render(80).find((line) => line.includes("Guardian:"))!;
    assert.ok(dark.startsWith(noteYellow({})("▌ ")), "dark is the default");
    assert.ok(dark.includes("\x1b[38;2;255;215;0m"));
    const light = build("ls", 40, () => {}, "light").render(80).find((line) => line.includes("Guardian:"))!;
    assert.ok(light.includes("\x1b[38;2;184;134;11m"));
    const header = build("ls", 40).render(80)[0]!;
    assert.ok(header.startsWith(noteYellow({})("●")), "the heading dot matches the note");
  });

  it("shows a command that fits in full", () => {
    const command = "echo a\necho b\necho c";
    const lines = strip(build(command, 40).render(80));
    for (const line of command.split("\n")) assert.ok(has(lines, line));
    assert.ok(!has(lines, "more lines"));
  });

  it("cuts a long command to a preview and points at the session", () => {
    const rows = 40;
    const lines = strip(build(longCommand, rows).render(80));
    assert.ok(has(lines, "echo line 1"));
    assert.ok(has(lines, `echo line ${rows / 4 - 1}`));
    assert.ok(!has(lines, `echo line ${rows / 4}`));
    assert.ok(has(lines, `… ${100 - (rows / 4 - 1)} more lines · ctrl+o view all, or scroll the session above`));
    assert.ok(has(lines, "Guardian:"));
    assert.ok(has(lines, "1. Allow"));
  });

  it("does not point a script-issued call at the session, which shows only the script", () => {
    const lines = strip(build(longCommand, 40, () => {}, undefined, false).render(80));
    assert.ok(has(lines, "more lines · ctrl+o view all"));
    assert.ok(!has(lines, "session above"));
  });

  it("leaves the wheel to the session while collapsed", () => {
    const prompt = build(longCommand, 40);
    prompt.render(80);
    assert.equal(prompt.handleMouse(wheel(3)), undefined);
  });

  it("ctrl+o opens the full command in a scrolling viewer that keeps the options", () => {
    const rows = 40;
    const prompt = build(longCommand, rows);
    prompt.handleInput(CTRL_O);
    let lines = strip(prompt.render(80));
    assert.ok(lines.length <= rows - 6, `rendered ${lines.length} rows`);
    assert.ok(lines.some((line) => /lines 1-\d+ of 100 .*ctrl\+o collapse/u.test(line)));
    assert.ok(has(lines, "Guardian:") && has(lines, "1. Allow"));
    for (let i = 0; i < 200; i++) prompt.handleInput(SHIFT_DOWN);
    lines = strip(prompt.render(80));
    assert.ok(has(lines, "echo line 100"), "every line is reachable");
    assert.deepEqual(prompt.handleMouse(wheel(-5)), { handled: true });
    lines = strip(prompt.render(80));
    assert.ok(!has(lines, "echo line 100"));
    prompt.handleInput(CTRL_O);
    lines = strip(prompt.render(80));
    assert.ok(has(lines, "more lines · ctrl+o view all"), "ctrl+o again collapses");
  });

  it("delegates selection keys to the selector", () => {
    let chosen: string | undefined;
    const prompt = build(longCommand, 30, (value) => (chosen = value));
    prompt.render(80);
    prompt.handleInput("2");
    assert.equal(chosen, "Block");
  });

  it("marks the last row so a clipped dock keeps the options in view", () => {
    const lines = build(longCommand, 30).render(80);
    assert.ok(lines.at(-1)!.startsWith(CURSOR_MARKER));
  });

  it("puts the note after the command in the plain-text form", () => {
    assert.equal(
      approvalPromptText({ header: "H", command: "C", noteLabel: "Guardian", note: "N" }),
      "H\n\nC\n\nGuardian: N",
    );
  });
});
