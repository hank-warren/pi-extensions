/**
 * Per-model request limits for pi-image-prune.
 *
 * Config lives at `<agent dir>/pi-image-prune.json`:
 *
 *     {
 *       "rules": [
 *         { "models": ["cpa/devin/*", "cpa/claude-opus-5-5"], "maxRequestBytes": 9500000, "trimToBytes": 6500000 }
 *       ]
 *     }
 *
 * `models` are `provider/id` globs (`*` matches anything, `/` included). The
 * first matching rule wins. A model no rule matches falls back to the Claude
 * Code defaults on the Anthropic Messages API and is left alone elsewhere.
 *
 * Loading never throws: a malformed file is ignored and reported through
 * `problem`, so a typo degrades to the defaults instead of disabling Pi.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILENAME = "pi-image-prune.json";

export interface PruneRule {
	models: string[];
	/** Estimated whole-request size that triggers pruning. */
	maxRequestBytes: number;
	/** Size pruning brings the request back down to. Defaults to 70% of `maxRequestBytes`. */
	trimToBytes: number;
	/** Image count limit. Defaults to the Claude Code limit on the Anthropic Messages API, else none. */
	maxImages?: number;
}

export interface PruneConfig {
	rules: PruneRule[];
	/** Why the file was ignored, when it was. Absent on a clean load. */
	problem?: string;
}

const RULE_FIELDS = new Set(["models", "maxRequestBytes", "trimToBytes", "maxImages"]);

function positiveInteger(value: unknown, field: string, index: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`rules[${index}].${field} must be a positive integer`);
	}
	return value;
}

function parseRule(value: unknown, index: number): PruneRule {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`rules[${index}] must be an object`);
	const input = value as Record<string, unknown>;
	const unknown = Object.keys(input).filter((key) => !RULE_FIELDS.has(key));
	if (unknown.length > 0) throw new Error(`rules[${index}] contains unknown field(s): ${unknown.join(", ")}`);

	const models = input.models;
	if (!Array.isArray(models) || models.length === 0 || !models.every((m) => typeof m === "string" && m.trim())) {
		throw new Error(`rules[${index}].models must be a non-empty array of "provider/id" globs`);
	}
	const maxRequestBytes = positiveInteger(input.maxRequestBytes, "maxRequestBytes", index);
	const trimToBytes =
		input.trimToBytes === undefined
			? Math.floor(maxRequestBytes * 0.7)
			: positiveInteger(input.trimToBytes, "trimToBytes", index);
	if (trimToBytes >= maxRequestBytes) throw new Error(`rules[${index}].trimToBytes must be below maxRequestBytes`);

	const rule: PruneRule = { models: models.map((m: string) => m.trim()), maxRequestBytes, trimToBytes };
	if (input.maxImages !== undefined) rule.maxImages = positiveInteger(input.maxImages, "maxImages", index);
	return rule;
}

/** Strict parse: unknown fields are errors, so a typo cannot silently disable a limit. */
export function parseConfig(value: unknown): PruneConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config must be an object");
	const input = value as Record<string, unknown>;
	const unknown = Object.keys(input).filter((key) => key !== "rules");
	if (unknown.length > 0) throw new Error(`config contains unknown field(s): ${unknown.join(", ")}`);
	if (input.rules === undefined) return { rules: [] };
	if (!Array.isArray(input.rules)) throw new Error("rules must be an array");
	return { rules: input.rules.map(parseRule) };
}

export function configPath(): string {
	return join(getAgentDir(), CONFIG_FILENAME);
}

export function loadConfig(path = configPath()): PruneConfig {
	if (!existsSync(path)) return { rules: [] };
	try {
		return parseConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { rules: [], problem: `${path}: ${message}` };
	}
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

/** First rule whose glob matches `provider/id`. */
export function matchRule(rules: readonly PruneRule[], provider: string, id: string): PruneRule | undefined {
	const key = `${provider}/${id}`;
	return rules.find((rule) => rule.models.some((glob) => globToRegExp(glob).test(key)));
}
