export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	cost: number;
	calls: number;
}

type SessionSource = "main" | "subagent";

export interface UsageRecord {
	fingerprint: string;
	timestamp: number;
	model: string;
	usage: UsageTotals;
	kind: "assistant" | "tool" | "summary" | "sidecar";
	toolName?: string;
	childSessionFiles?: string[];
}

/**
 * One recorded tool call. Kept separate from UsageRecord because most tool calls carry no
 * model usage at all: mixing zero-usage records into the usage list would distort model
 * attribution and call counts on the Models tab.
 */
export interface ToolCallRecord {
	/** Provider tool-call id when present, else a synthetic hash. Copied forks repeat it, so it deduplicates. */
	fingerprint: string;
	timestamp: number;
	toolName: string;
	isError: boolean;
}

export interface SessionRecord {
	path: string;
	sessionId: string;
	cwd: string;
	createdAt: number;
	lastActivityAt: number;
	source: SessionSource;
	usage: UsageRecord[];
	toolCalls: ToolCallRecord[];
}

export interface CachedFileRecord {
	size: number;
	mtimeMs: number;
	ignored?: true;
	session?: SessionRecord;
	/** Usage recorded by extensions whose model calls never reach a session transcript. */
	sidecar?: UsageRecord[];
	malformedLines: number;
}

export interface StatsCacheFile {
	version: 3;
	files: Record<string, CachedFileRecord>;
}

export interface ScanDiagnostics {
	discoveredFiles: number;
	parsedFiles: number;
	reusedFiles: number;
	ignoredFiles: number;
	unreadableFiles: number;
	malformedLines: number;
}

export interface StatsIndex {
	sessions: SessionRecord[];
	usage: UsageRecord[];
	toolCalls: ToolCallRecord[];
	diagnostics: ScanDiagnostics;
}

export type StatsRange = "all" | "7d" | "30d";

export interface ModelStats extends UsageTotals {
	model: string;
	total: number;
	share: number;
}

export interface DayStats {
	day: string;
	total: number;
}

export interface ToolStats {
	toolName: string;
	/** Owning package/extension from the live tool registry, or undefined for tools no longer installed. */
	source?: string;
	calls: number;
	errors: number;
	share: number;
}

export interface ProjectStats {
	/** Absolute working directory recorded in the session header. */
	cwd: string;
	/** Short display label, normally the directory basename. */
	label: string;
	sessions: number;
	total: number;
	cost: number;
	share: number;
}

export interface StatsSnapshot {
	range: StatsRange;
	allTime: UsageTotals;
	period: UsageTotals;
	currentSession: UsageTotals;
	models: ModelStats[];
	tools: ToolStats[];
	projects: ProjectStats[];
	days: DayStats[];
	sessionCount: number;
	mainSessionCount: number;
	subagentSessionCount: number;
	activeDays: number;
	currentStreak: number;
	longestStreak: number;
	mostActiveDay?: DayStats;
	favoriteModel?: string;
	longestSessionMs: number;
	diagnostics: ScanDiagnostics;
}

export function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, calls: 0 };
}

export function addUsage(target: UsageTotals, usage: UsageTotals): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.reasoning += usage.reasoning;
	target.cost += usage.cost;
	target.calls += usage.calls;
}

export function totalTokens(usage: UsageTotals): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
