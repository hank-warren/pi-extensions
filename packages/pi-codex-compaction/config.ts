import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export interface LegacyCompactionConfig {
	autoCompact: boolean;
	thresholdRatio: number;
}

const DEFAULT_CONFIG: LegacyCompactionConfig = {
	autoCompact: true,
	thresholdRatio: 0.9,
};

// Proxy eligibility is global-only; a project's config cannot opt a provider in.
// An empty list disables CPA support. Direct Codex behavior is independent.
export function loadCpaProviders(): string[] {
	try {
		const parsed = JSON.parse(readFileSync(join(getAgentDir(), "pi-codex-compaction.json"), "utf8"));
		if (!Array.isArray(parsed?.cpaProviders)) return ["cpa"];
		return [...new Set<string>(parsed.cpaProviders.filter(
			(value: unknown): value is string => typeof value === "string" && value.trim().length > 0,
		).map((value: string) => value.trim()))];
	} catch {
		return ["cpa"];
	}
}

function readConfig(path: string): Partial<LegacyCompactionConfig> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return {
			...(typeof parsed.autoCompact === "boolean" ? { autoCompact: parsed.autoCompact } : {}),
			...(
				typeof parsed.thresholdRatio === "number" && parsed.thresholdRatio > 0 && parsed.thresholdRatio < 1
					? { thresholdRatio: parsed.thresholdRatio }
					: {}
			),
		};
	} catch {
		return {};
	}
}

export function loadLegacyConfig(cwd: string, projectTrusted: boolean): LegacyCompactionConfig {
	const globalConfig = readConfig(join(getAgentDir(), "pi-codex-compaction.json"));
	const projectConfig = projectTrusted
		? readConfig(join(cwd, CONFIG_DIR_NAME, "pi-codex-compaction.json"))
		: {};
	return { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
}
