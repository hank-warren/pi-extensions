#!/usr/bin/env node
/**
 * Parse `changeset publish` output into the machine-readable release list.
 *
 * `changeset publish` prints one "New tag: <name>@<version>" line per package it
 * actually published, and that is the only record of what a run shipped. This
 * used to be an inline node -e snippet inside publish.yml, where it could not be
 * tested; publish.yml now shells out here instead.
 *
 * Usage:
 *   node scripts/parse-published.mjs <publish-log-file>
 *   npm run publish-packages | node scripts/parse-published.mjs
 *   node scripts/parse-published.mjs --classify <publish-log-file>
 *
 * Default mode emits a JSON array of {name, version} on stdout — the shape
 * scripts/create-releases.sh consumes — and nothing else, so callers can capture
 * it directly. No matches yields "[]", which is a legitimate no-op publish.
 *
 * --classify additionally splits the failures `changeset publish` reports (it
 * exits 1 on any) into benign and real; see classifyPublish below. It emits
 * {published, alreadyPublished, failed}.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Names are optionally scoped (@hank-warren/pi-stats); the version runs to the
// first whitespace so prerelease and build metadata survive intact.
const NEW_TAG_RE = /New tag:\s+((?:@[^/\s]+\/)?[^@\s]+)@(\S+)/g;

// changesets ends a failed run with "packages failed to publish:" followed by
// one "<name>@<version>" line per package (@changesets/cli logReleases).
const FAILED_HEADER_RE = /packages failed to publish:/;
const RELEASE_LINE_RE = /^(?:🦋\s+)?((?:@[^/\s]+\/)?[^@\s]+)@(\S+)\s*$/;

// Per-package failure: "an error occurred while publishing <name>: <code> <summary>".
// changesets logs the npm error code and summary on one line.
const PUBLISH_ERROR_RE = /an error occurred while publishing ((?:@[^/\s]+\/)?\S+?): (E\d+)\b(.*)/;

// npm's write side is strongly consistent, unlike the read side changesets
// consults with `npm info`. This exact 403 is therefore positive confirmation
// that the version is already on the registry, not a failure to publish it.
const ALREADY_PUBLISHED_RE = /cannot publish over the previously published versions?:\s*([^\n]+)/i;

// changesets colours its output; strip escapes before matching.
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/**
 * @param {string} text raw `changeset publish` stdout+stderr
 * @returns {{ name: string, version: string }[]} one entry per published package
 */
export function parsePublished(text) {
  const packages = [];
  const re = new RegExp(NEW_TAG_RE.source, NEW_TAG_RE.flags);
  for (let match; (match = re.exec(text)); ) {
    packages.push({ name: match[1], version: match[2] });
  }
  return packages;
}

/**
 * Split the packages `changeset publish` reported as failed into the ones npm
 * rejected *because the version is already published* and the ones that really
 * failed.
 *
 * The benign case is not hypothetical: `changeset publish` decides what to
 * publish from `npm info`, which reads npm's eventually consistent read side.
 * For 5-10 minutes after a package name's first publish that read 404s, so a
 * run in that window re-attempts a version that is already on npm and npm's
 * write side rejects it with E403 "You cannot publish over the previously
 * published versions: <version>". Nothing is wrong — the publish it wanted to
 * make had already happened.
 *
 * Classification is deliberately fail-closed: a failed package is only benign
 * when an E403 line names it *and* quotes the exact version that failed.
 * Anything unrecognised (a genuine 403, an auth error, a drifted log format)
 * stays in `failed` so publish.yml goes red.
 *
 * @param {string} text raw `changeset publish` stdout+stderr
 * @returns {{
 *   published: { name: string, version: string }[],
 *   alreadyPublished: { name: string, version: string }[],
 *   failed: { name: string, version: string }[],
 * }}
 */
export function classifyPublish(text) {
  const clean = text.replace(ANSI_RE, "");
  const published = parsePublished(clean);
  const alreadyPublishedVersions = collectAlreadyPublished(clean);

  const alreadyPublished = [];
  const failed = [];
  for (const pkg of parseFailed(clean)) {
    const versions = alreadyPublishedVersions.get(pkg.name);
    if (versions?.has(pkg.version)) {
      alreadyPublished.push(pkg);
    } else {
      failed.push(pkg);
    }
  }
  return { published, alreadyPublished, failed };
}

/**
 * Read the "packages failed to publish:" block. The block runs to the first
 * line that is not a "<name>@<version>" release line, which is how changesets
 * terminates it (it throws straight after printing).
 *
 * @param {string} clean ANSI-stripped log
 * @returns {{ name: string, version: string }[]}
 */
function parseFailed(clean) {
  const lines = clean.split("\n");
  const start = lines.findIndex((line) => FAILED_HEADER_RE.test(line));
  if (start === -1) return [];

  const failed = [];
  for (const line of lines.slice(start + 1)) {
    // changesets prefixes log lines with "🦋  " plus a level word; release lines
    // carry no level word, so the emoji is the only prefix to tolerate. Any
    // other line (including a blank one) ends the block.
    const match = RELEASE_LINE_RE.exec(line);
    if (!match) break;
    failed.push({ name: match[1], version: match[2] });
  }
  return failed;
}

/**
 * Map package name -> set of versions npm reported as already published.
 *
 * @param {string} clean ANSI-stripped log
 * @returns {Map<string, Set<string>>}
 */
function collectAlreadyPublished(clean) {
  const found = new Map();
  for (const line of clean.split("\n")) {
    const error = PUBLISH_ERROR_RE.exec(line);
    if (!error || error[2] !== "E403") continue;
    const already = ALREADY_PUBLISHED_RE.exec(error[3]);
    if (!already) continue;
    // npm lists the offending versions comma-separated and ends the sentence
    // with a period ("...versions: 0.2.0."), and changesets may append the error
    // detail to the same line. Keep the leading token of each comma segment and
    // drop that sentence period; a version can contain dots, so this cannot
    // just stop at the first one.
    const versions = already[1]
      .split(",")
      .map((segment) => segment.trim().split(/\s+/)[0].replace(/\.$/, ""))
      .filter(Boolean);
    const set = found.get(error[1]) ?? new Set();
    for (const version of versions) set.add(version);
    found.set(error[1], set);
  }
  return found;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main(argv) {
  const classify = argv[0] === "--classify";
  const [logPath] = classify ? argv.slice(1) : argv;
  const text = logPath ? readFileSync(logPath, "utf8") : readStdin();
  process.stdout.write(JSON.stringify(classify ? classifyPublish(text) : parsePublished(text)));
}

// Only run when invoked as a script; the unit test imports parsePublished.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
