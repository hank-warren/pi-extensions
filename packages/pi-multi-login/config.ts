import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const CONFIG_FILENAME = "pi-multi-login.json";

/**
 * Provider ids are `${base}-${suffix}`, so the suffix has to survive being
 * concatenated into an id and split back out by longest-prefix match. A
 * lowercase slug is the only shape that round-trips unambiguously.
 */
const SUFFIX_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** One additional login for an existing OAuth provider. */
export interface AliasEntry {
	/** Provider id whose OAuth flow, transport and catalog the alias reuses. */
	base: string;
	/** Slug appended to `base` to form the alias provider id. */
	suffix: string;
	/** Display name. Defaults to `${baseProviderName} (${suffix})`. */
	name?: string;
}

interface MultiLoginConfig {
	aliases: AliasEntry[];
}

export function multiLoginConfigPath(): string {
	return process.env.PI_MULTI_LOGIN_CONFIG
		? resolve(process.env.PI_MULTI_LOGIN_CONFIG)
		: join(getAgentDir(), CONFIG_FILENAME);
}

export function aliasProviderId(base: string, suffix: string): string {
	return `${base}-${suffix}`;
}

export function aliasEntryId(entry: AliasEntry): string {
	return aliasProviderId(entry.base, entry.suffix);
}

export function aliasDisplayName(entry: AliasEntry, baseProviderName: string): string {
	return entry.name ?? `${baseProviderName} (${entry.suffix})`;
}

export function isValidAliasSuffix(value: unknown): value is string {
	return typeof value === "string" && SUFFIX_PATTERN.test(value);
}

function nonEmptyString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}

function parseAliasEntry(value: unknown, index: number): AliasEntry {
	const name = `aliases[${index}]`;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	const input = value as Record<string, unknown>;
	const base = nonEmptyString(input.base, `${name}.base`);
	const suffix = nonEmptyString(input.suffix, `${name}.suffix`);
	if (!isValidAliasSuffix(suffix)) {
		throw new Error(`${name}.suffix must be a lowercase slug such as "work" or "auto-permissions"`);
	}
	const label = input.name === undefined ? undefined : nonEmptyString(input.name, `${name}.name`);
	return { base, suffix, ...(label === undefined ? {} : { name: label }) };
}

/** Unknown keys are ignored so a newer config never breaks an older install. */
export function parseMultiLoginConfig(value: unknown): MultiLoginConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("multi-login config must be an object");
	}
	const input = value as Record<string, unknown>;
	if (input.aliases === undefined) return { aliases: [] };
	if (!Array.isArray(input.aliases)) throw new Error("aliases must be an array");

	const seen = new Set<string>();
	const aliases = input.aliases.map((entry, index) => parseAliasEntry(entry, index));
	for (const entry of aliases) {
		const id = aliasEntryId(entry);
		if (seen.has(id)) throw new Error(`aliases contains duplicate provider id: ${id}`);
		seen.add(id);
	}
	return { aliases };
}

export function loadMultiLoginConfig(path = multiLoginConfigPath()): MultiLoginConfig {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`could not read ${path}: ${message}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`could not parse ${path}: ${message}`);
	}
	return parseMultiLoginConfig(value);
}

/**
 * Merge `aliases` into whatever is on disk and publish it atomically.
 *
 * Merging keeps the promise `parseMultiLoginConfig` already makes: unknown keys
 * are ignored on read *so a newer config never breaks an older install*, which
 * only holds if the writer leaves them alone too. Serializing a bare
 * `{ aliases }` snapshot deleted them instead.
 *
 * Publishing through a temp file and a rename is why a failed write cannot cost
 * the user their logins. Writing the live path directly truncates it first, and
 * a config left unparseable makes the extension register no aliases at all
 * while `multiLoginConfigExists` still returns true — so the one-time credential
 * adoption never re-runs to rebuild it.
 */
export function saveMultiLoginConfig(config: MultiLoginConfig, path = multiLoginConfigPath()): void {
	let existing: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			existing = parsed as Record<string, unknown>;
		}
	} catch {
		// A missing or unreadable file simply has nothing to preserve. The
		// aliases being written are still published in full.
	}

	const document = `${JSON.stringify({ ...existing, aliases: config.aliases }, null, 2)}\n`;
	const directory = dirname(path);
	const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
	mkdirSync(directory, { recursive: true });
	try {
		writeFileSync(temporaryPath, document, { encoding: "utf8", flag: "wx", mode: 0o600 });
		renameSync(temporaryPath, path);
	} finally {
		try {
			rmSync(temporaryPath, { force: true });
		} catch {
			// Best-effort cleanup must not replace the save result.
		}
	}
}

export function multiLoginConfigExists(path = multiLoginConfigPath()): boolean {
	return existsSync(path);
}
