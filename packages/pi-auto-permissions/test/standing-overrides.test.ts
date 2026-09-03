import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendStandingApproval,
  buildStandingApprovalRecord,
  grantStandingApproval,
  readStandingApprovals,
  revokeStandingApproval,
  standingApprovalsToPermissionOverrides,
  STANDING_APPROVAL_LIMIT,
} from "../standing-overrides.ts";

const dirs: string[] = [];

function fixturePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-standing-approvals-"));
  dirs.push(dir);
  return join(dir, "nested", "standing-approvals.jsonl");
}

function record(index: number) {
  return buildStandingApprovalRecord({
    timestamp: new Date(Date.UTC(2026, 7, 1, 0, 0, index)),
    gate: { label: "Remote command", group: "ssh" },
    command: `ssh host-${index}.example uptime`,
    project: "/work/project",
    reason: "The target was not authorized by the current request.",
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("standing approvals ledger", () => {
  test("builds the bounded v1 comparable-command record shape", () => {
    assert.deepEqual(record(0), {
      v: 1,
      ts: "2026-08-01T00:00:00.000Z",
      gate: { label: "Remote command", group: "ssh" },
      command: "ssh host-0.example uptime",
      scope: "comparable",
      project: "/work/project",
      reason: "The target was not authorized by the current request.",
    });
  });

  test("refreshes duplicate gate-group commands instead of accumulating them", () => {
    const path = fixturePath();
    const first = record(1);
    const refreshed = { ...record(2), command: first.command, reason: "updated concern" };
    appendStandingApproval(path, first);
    appendStandingApproval(path, refreshed);
    assert.deepEqual(readStandingApprovals(path), [refreshed]);
  });

  test("an exclusive lock makes concurrent read-modify-write fail safely", () => {
    const path = fixturePath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(`${path}.lock`, "held", { mode: 0o600 });
    assert.throws(() => appendStandingApproval(path, record(1)), /EEXIST/);
    assert.deepEqual(readStandingApprovals(path), []);
  });

  test("recovers a stale lock left behind by a crashed writer", () => {
    const path = fixturePath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(`${path}.lock`, "abandoned", { mode: 0o600 });
    const stale = new Date(Date.now() - 120_000);
    utimesSync(`${path}.lock`, stale, stale);

    appendStandingApproval(path, record(1));

    assert.deepEqual(readStandingApprovals(path), [record(1)]);
    assert.throws(() => statSync(`${path}.lock`), /ENOENT/);
  });

  test("writes mode 0600, caps at 200, and evicts the oldest record", () => {
    const path = fixturePath();
    let lastEvicted = 0;
    for (let index = 0; index <= STANDING_APPROVAL_LIMIT; index += 1) {
      lastEvicted = appendStandingApproval(path, record(index)).evicted;
    }
    const records = readStandingApprovals(path);
    assert.equal(records.length, STANDING_APPROVAL_LIMIT);
    assert.equal(records[0]?.command, "ssh host-1.example uptime");
    assert.equal(records.at(-1)?.command, `ssh host-${STANDING_APPROVAL_LIMIT}.example uptime`);
    assert.equal(lastEvicted, 1);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  test("skips malformed lines without losing later valid records", () => {
    const path = fixturePath();
    const valid = record(4);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      ["not json", JSON.stringify({ v: 2 }), JSON.stringify(valid), JSON.stringify({ ...valid, command: "" })].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    assert.deepEqual(readStandingApprovals(path), [valid]);
  });

  test("a standing prompt grant appends the ledger and yields live comparable evidence", () => {
    const path = fixturePath();
    const granted = grantStandingApproval(
      path,
      {
        timestamp: new Date("2026-08-20T12:00:00.000Z"),
        gate: { label: "Remote command", group: "ssh" },
        command: "ssh demo.example uptime",
        project: "/work/demo",
        reason: "The remote status check was not named.",
      },
      7,
      "user:latest",
    );
    assert.deepEqual(readStandingApprovals(path), [granted.record]);
    assert.equal(granted.override.seq, 7);
    assert.equal(granted.override.anchorKey, "user:latest");
    assert.equal(granted.override.choice, "allow_unnecessary");
    assert.deepEqual(granted.override.standing, {
      grantedAt: "2026-08-20T12:00:00.000Z",
      project: "/work/demo",
      gateGroup: "ssh",
    });
  });

  test("session-start projection loads every ledger record before session evidence", () => {
    const overrides = standingApprovalsToPermissionOverrides([record(1), record(2)]);
    assert.deepEqual(overrides.map((override) => override.seq), [-2, -1]);
    assert.ok(overrides.every((override) => override.anchorKey === ""));
    assert.ok(overrides.every((override) => override.standing));
  });

  test("revokes one selected record and preserves 0600", () => {
    const path = fixturePath();
    const first = record(1);
    const second = record(2);
    appendStandingApproval(path, first);
    appendStandingApproval(path, second);

    assert.equal(revokeStandingApproval(path, first), true);
    assert.deepEqual(readStandingApprovals(path), [second]);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(revokeStandingApproval(path, first), false);
  });
});
