import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
	addUsage,
	emptyUsage,
	totalTokens,
	type DayStats,
	type ModelStats,
	type ProjectStats,
	type SessionRecord,
	type StatsIndex,
	type StatsRange,
	type StatsSnapshot,
	type ToolCallRecord,
	type ToolStats,
	type UsageRecord,
	type UsageTotals,
} from "./types.ts";

/** Bucket for usage that carries no attributable response model. */
const SUMMARY_MODEL = "Tools/summaries";

interface ParseResult {
	ignored: boolean;
	malformedLines: number;
	session?: SessionRecord;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function firstNumber(source: Record<string, unknown>, names: string[]): number {
	for (const name of names) {
		if (typeof source[name] === "number") return finite(source[name]);
	}
	return 0;
}

function normalizeUsage(value: unknown): UsageTotals | undefined {
	const usage = object(value);
	if (!usage) return undefined;
	const cost = object(usage.cost);
	return {
		input: firstNumber(usage, ["input", "inputTokens"]),
		output: firstNumber(usage, ["output", "outputTokens"]),
		cacheRead: firstNumber(usage, ["cacheRead", "cacheReadTokens"]),
		cacheWrite: firstNumber(usage, ["cacheWrite", "cacheWriteTokens"]),
		reasoning: firstNumber(usage, ["reasoning", "reasoningTokens"]),
		cost: cost ? firstNumber(cost, ["total"]) : firstNumber(usage, ["costUsd", "cost"]),
		calls: 1,
	};
}

function timestamp(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function modelName(provider: unknown, model: unknown): string {
	const providerText = typeof provider === "string" ? provider : "";
	const modelText = typeof model === "string" && model.length > 0 ? model : "unknown";
	if (!providerText || modelText.includes("/")) return modelText;
	return `${providerText}/${modelText}`;
}

function detailsModel(details: unknown): string | undefined {
	const candidate = object(details)?.model;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/**
 * Pi records placeholder assistant messages for turns it generates itself; today they
 * carry the literal model `<synthetic>`, and a missing model normalizes to `unknown`.
 * Angle brackets are never valid in a provider model id, so they are a safe marker.
 */
function placeholderModel(model: string): boolean {
	const bare = model.slice(model.lastIndexOf("/") + 1);
	return bare === "unknown" || (bare.startsWith("<") && bare.endsWith(">"));
}

function unmetered(usage: UsageTotals): boolean {
	return totalTokens(usage) === 0 && usage.reasoning === 0 && usage.cost === 0;
}

/**
 * Placeholder models that recorded no tokens and no cost would otherwise get their own
 * zero-value model row. Roll them into the unattributed bucket so the call is still
 * counted without inventing a model that was never billed.
 */
function attributedModel(model: string, usage: UsageTotals): string {
	return placeholderModel(model) && unmetered(usage) ? SUMMARY_MODEL : model;
}

function nestedSubagentUsage(details: unknown): UsageTotals | undefined {
	const record = object(details);
	if (!record) return undefined;
	const aggregate = normalizeUsage(record.totalChildUsage);
	if (aggregate) return aggregate;
	if (!Array.isArray(record.results)) return undefined;
	const total = emptyUsage();
	let found = false;
	for (const result of record.results) {
		const normalized = normalizeUsage(object(result)?.usage);
		if (!normalized) continue;
		addUsage(total, normalized);
		found = true;
	}
	return found ? total : undefined;
}

function childSessionFiles(details: unknown, sessionFile: string): string[] {
	const found = new Set<string>();
	const visit = (value: unknown, depth: number): void => {
		if (depth > 6) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
			return;
		}
		const record = object(value);
		if (!record) return;
		for (const [key, item] of Object.entries(record)) {
			if (key === "sessionFile" && typeof item === "string" && item.length > 0) {
				found.add(resolve(dirname(sessionFile), item));
			} else if (typeof item === "object" && item !== null) {
				visit(item, depth + 1);
			}
		}
	};
	visit(details, 0);
	return [...found];
}

function fingerprint(parts: unknown[]): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

function normalizeEntry(
	entryValue: unknown,
	sessionId: string,
	sessionFile: string,
	lineIndex: number,
	fallbackTimestamp: number,
): UsageRecord | undefined {
	const entry = object(entryValue);
	if (!entry) return undefined;
	const entryTimestamp = timestamp(entry.timestamp, fallbackTimestamp);
	const id = typeof entry.id === "string" ? entry.id : `${sessionId}:${lineIndex}`;

	if (entry.type === "message") {
		const message = object(entry.message);
		if (!message) return undefined;
		const role = message.role;
		if (role === "assistant") {
			const usage = normalizeUsage(message.usage);
			if (!usage) return undefined;
			const model = attributedModel(modelName(message.provider, message.responseModel ?? message.model), usage);
			return {
				fingerprint: fingerprint([id, entry.timestamp, "assistant", model, usage]),
				timestamp: timestamp(message.timestamp, entryTimestamp),
				model,
				usage,
				kind: "assistant",
			};
		}
		if (role === "toolResult") {
			const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
			const usage = normalizeUsage(message.usage) ?? (toolName === "subagent" ? nestedSubagentUsage(message.details) : undefined);
			if (!usage) return undefined;
			const model = attributedModel(detailsModel(message.details) ?? SUMMARY_MODEL, usage);
			const children = toolName === "subagent" ? childSessionFiles(message.details, sessionFile) : [];
			return {
				fingerprint: fingerprint([id, entry.timestamp, "tool", toolName, model, usage]),
				timestamp: timestamp(message.timestamp, entryTimestamp),
				model,
				usage,
				kind: "tool",
				toolName,
				...(children.length > 0 ? { childSessionFiles: children } : {}),
			};
		}
		return undefined;
	}

	if (entry.type === "compaction" || entry.type === "branch_summary") {
		const usage = normalizeUsage(entry.usage);
		if (!usage) return undefined;
		return {
			fingerprint: fingerprint([id, entry.timestamp, entry.type, SUMMARY_MODEL, usage]),
			timestamp: entryTimestamp,
			model: SUMMARY_MODEL,
			usage,
			kind: "summary",
		};
	}
	return undefined;
}

/**
 * Extract a tool call from any toolResult entry, whether or not it recorded model usage.
 * normalizeEntry deliberately drops usage-free results; this is the parallel path that keeps them.
 */
function normalizeToolCall(
	entryValue: unknown,
	sessionId: string,
	lineIndex: number,
	fallbackTimestamp: number,
): ToolCallRecord | undefined {
	const entry = object(entryValue);
	if (!entry || entry.type !== "message") return undefined;
	const message = object(entry.message);
	if (!message || message.role !== "toolResult") return undefined;
	const toolName = typeof message.toolName === "string" && message.toolName.length > 0 ? message.toolName : "tool";
	const entryTimestamp = timestamp(entry.timestamp, fallbackTimestamp);
	// The provider tool-call id survives session forks verbatim, so it is the natural dedup key.
	const toolCallId = typeof message.toolCallId === "string" && message.toolCallId.length > 0 ? message.toolCallId : undefined;
	return {
		fingerprint: toolCallId ?? fingerprint([sessionId, lineIndex, toolName, entryTimestamp]).slice(0, 16),
		timestamp: timestamp(message.timestamp, entryTimestamp),
		toolName: normalizeToolName(toolName),
		isError: message.isError === true,
	};
}

/** Providers sometimes namespace tool names (`functions.bash`); rank them as one tool. */
function normalizeToolName(toolName: string): string {
	const separator = toolName.lastIndexOf(".");
	const tail = separator >= 0 ? toolName.slice(separator + 1) : toolName;
	return tail.length > 0 ? tail : toolName;
}

function sessionSource(filePath: string): "main" | "subagent" {
	return /(?:^|\/)run-\d+\/session\.jsonl$/.test(filePath) ? "subagent" : "main";
}

export function parseSessionText(filePath: string, text: string): ParseResult {
	const lines = text.split("\n");
	let header: Record<string, unknown> | undefined;
	try {
		header = object(JSON.parse(lines[0]?.trim() ?? ""));
	} catch {
		return { ignored: true, malformedLines: 0 };
	}
	if (!header || header.type !== "session" || typeof header.id !== "string") {
		return { ignored: true, malformedLines: 0 };
	}

	const headerTimestamp = timestamp(header.timestamp, 0);
	const usage: UsageRecord[] = [];
	const toolCalls: ToolCallRecord[] = [];
	let malformedLines = 0;
	let earliestActivityAt = Number.POSITIVE_INFINITY;
	let lastActivityAt = headerTimestamp;
	for (let index = 1; index < lines.length; index++) {
		const line = lines[index]?.trim();
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as unknown;
			const entryRecord = object(entry);
			const entryTimestamp = timestamp(entryRecord?.timestamp, 0);
			if (entryTimestamp > 0) {
				earliestActivityAt = Math.min(earliestActivityAt, entryTimestamp);
				lastActivityAt = Math.max(lastActivityAt, entryTimestamp);
			}
			const toolCall = normalizeToolCall(entry, header.id, index, headerTimestamp || entryTimestamp);
			if (toolCall) toolCalls.push(toolCall);
			const normalized = normalizeEntry(entry, header.id, filePath, index, headerTimestamp || entryTimestamp);
			if (normalized) {
				usage.push(normalized);
				if (normalized.timestamp > 0) {
					earliestActivityAt = Math.min(earliestActivityAt, normalized.timestamp);
					lastActivityAt = Math.max(lastActivityAt, normalized.timestamp);
				}
			}
		} catch {
			malformedLines++;
		}
	}

	const createdAt = headerTimestamp || (Number.isFinite(earliestActivityAt) ? earliestActivityAt : 0);
	return {
		ignored: false,
		malformedLines,
		session: {
			path: resolve(filePath),
			sessionId: header.id,
			cwd: typeof header.cwd === "string" ? header.cwd : "",
			createdAt,
			lastActivityAt: Math.max(lastActivityAt, createdAt),
			source: sessionSource(filePath),
			usage,
			toolCalls,
		},
	};
}

/**
 * Parse a usage sidecar: one content-free JSON record per model call made outside a Pi
 * session transcript, such as pi-auto-permissions guardian reviews.
 */
export function parseUsageSidecar(filePath: string, text: string): { records: UsageRecord[]; malformedLines: number } {
	const records: UsageRecord[] = [];
	let malformedLines = 0;
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]?.trim();
		if (!line) continue;
		let entry: Record<string, unknown> | undefined;
		try {
			entry = object(JSON.parse(line));
		} catch {
			malformedLines++;
			continue;
		}
		if (!entry || entry.v !== 1) {
			malformedLines++;
			continue;
		}
		const usage = normalizeUsage(entry.usage);
		if (!usage) {
			malformedLines++;
			continue;
		}
		const label = typeof entry.label === "string" && entry.label.length > 0 ? entry.label : undefined;
		const source = typeof entry.source === "string" && entry.source.length > 0 ? entry.source : "sidecar";
		const model = `${modelName(entry.provider, entry.model)} (${label ?? source})`;
		const identity = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : `${resolve(filePath)}:${index}`;
		records.push({
			fingerprint: fingerprint([identity, entry.ts, source, model, usage]),
			timestamp: timestamp(entry.ts, 0),
			model,
			usage,
			kind: "sidecar",
			toolName: source,
		});
	}
	return { records, malformedLines };
}

export function usageFromEntries(
	sessionId: string,
	entries: readonly unknown[],
	fallbackTimestamp = Date.now(),
	sessionFile = "current-session.jsonl",
): UsageRecord[] {
	return entries.flatMap((entry, index) => {
		const normalized = normalizeEntry(entry, sessionId, sessionFile, index, fallbackTimestamp);
		return normalized ? [normalized] : [];
	});
}

/** Tool calls for the live in-memory session, which has no file on disk to rescan. */
export function toolCallsFromEntries(
	sessionId: string,
	entries: readonly unknown[],
	fallbackTimestamp = Date.now(),
): ToolCallRecord[] {
	return entries.flatMap((entry, index) => {
		const normalized = normalizeToolCall(entry, sessionId, index, fallbackTimestamp);
		return normalized ? [normalized] : [];
	});
}

function hasPersistedSubagentChild(record: UsageRecord, sessionPaths: ReadonlySet<string>): boolean {
	return record.toolName === "subagent" && Boolean(record.childSessionFiles?.some((file) => sessionPaths.has(resolve(file))));
}

function deduplicateToolCalls(sessions: readonly SessionRecord[]): ToolCallRecord[] {
	const seen = new Set<string>();
	const result: ToolCallRecord[] = [];
	for (const session of sessions) {
		for (const record of session.toolCalls ?? []) {
			if (seen.has(record.fingerprint)) continue;
			seen.add(record.fingerprint);
			result.push(record);
		}
	}
	return result;
}

export function deduplicateUsage(sessions: readonly SessionRecord[], sidecar: readonly UsageRecord[] = []): UsageRecord[] {
	const sessionPaths = new Set(sessions.map((session) => resolve(session.path)));
	const seen = new Set<string>();
	const result: UsageRecord[] = [];
	for (const session of sessions) {
		for (const record of session.usage) {
			if (hasPersistedSubagentChild(record, sessionPaths)) continue;
			if (seen.has(record.fingerprint)) continue;
			seen.add(record.fingerprint);
			result.push(record);
		}
	}
	for (const record of sidecar) {
		if (seen.has(record.fingerprint)) continue;
		seen.add(record.fingerprint);
		result.push(record);
	}
	return result;
}

function localDay(time: number): string {
	const date = new Date(time);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function dayStart(now: number, daysBack: number): number {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	date.setDate(date.getDate() - daysBack);
	return date.getTime();
}

function rangeStart(range: StatsRange, now: number): number {
	if (range === "7d") return dayStart(now, 6);
	if (range === "30d") return dayStart(now, 29);
	return Number.NEGATIVE_INFINITY;
}

function total(records: readonly UsageRecord[]): UsageTotals {
	const result = emptyUsage();
	for (const record of records) addUsage(result, record.usage);
	return result;
}

function aggregateModels(records: readonly UsageRecord[]): ModelStats[] {
	const byModel = new Map<string, UsageTotals>();
	for (const record of records) {
		const aggregate = byModel.get(record.model) ?? emptyUsage();
		addUsage(aggregate, record.usage);
		byModel.set(record.model, aggregate);
	}
	const grandTotal = [...byModel.values()].reduce((sum, usage) => sum + totalTokens(usage), 0);
	return [...byModel.entries()]
		.map(([model, usage]) => ({ ...usage, model, total: totalTokens(usage), share: grandTotal > 0 ? totalTokens(usage) / grandTotal : 0 }))
		.sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
}

function aggregateTools(records: readonly ToolCallRecord[], sources: ReadonlyMap<string, string>): ToolStats[] {
	const byTool = new Map<string, { calls: number; errors: number }>();
	for (const record of records) {
		const aggregate = byTool.get(record.toolName) ?? { calls: 0, errors: 0 };
		aggregate.calls++;
		if (record.isError) aggregate.errors++;
		byTool.set(record.toolName, aggregate);
	}
	const grandTotal = [...byTool.values()].reduce((sum, entry) => sum + entry.calls, 0);
	return [...byTool.entries()]
		.map(([toolName, entry]): ToolStats => {
			const source = sources.get(toolName);
			return {
				toolName,
				...(source ? { source } : {}),
				calls: entry.calls,
				errors: entry.errors,
				share: grandTotal > 0 ? entry.calls / grandTotal : 0,
			};
		})
		.sort((a, b) => b.calls - a.calls || a.toolName.localeCompare(b.toolName));
}

/** Sessions carry an absolute cwd; the basename is the useful label, with a parent hint when ambiguous. */
function projectLabel(cwd: string): string {
	const normalized = cwd.replace(/[/\\]+$/, "");
	const parts = normalized.split(/[/\\]/).filter((part) => part.length > 0);
	return parts[parts.length - 1] ?? normalized;
}

/**
 * Roll sessions up by working directory.
 *
 * `counted` holds the fingerprints that survived de-duplication, so forked history and usage
 * already attributed to a persisted subagent child are not counted a second time here. Without
 * it the project totals would exceed the all-time total they are supposed to partition.
 */
function aggregateProjects(
	sessions: readonly SessionRecord[],
	counted: ReadonlySet<string>,
	cutoff: number,
	now: number,
): ProjectStats[] {
	const byProject = new Map<string, { sessions: number; total: number; cost: number }>();
	const seen = new Set<string>();
	for (const session of sessions) {
		if (!session.cwd) continue;
		const records = session.usage.filter((record) => {
			if (record.timestamp < cutoff || record.timestamp > now) return false;
			if (!counted.has(record.fingerprint) || seen.has(record.fingerprint)) return false;
			seen.add(record.fingerprint);
			return true;
		});
		// A session counts toward its project whenever it was active in range, even with no billed usage.
		const active = records.length > 0 || (session.lastActivityAt >= cutoff && session.lastActivityAt <= now);
		if (!active) continue;
		const aggregate = byProject.get(session.cwd) ?? { sessions: 0, total: 0, cost: 0 };
		aggregate.sessions++;
		for (const record of records) {
			aggregate.total += totalTokens(record.usage);
			aggregate.cost += record.usage.cost;
		}
		byProject.set(session.cwd, aggregate);
	}
	const grandTotal = [...byProject.values()].reduce((sum, entry) => sum + entry.total, 0);
	return [...byProject.entries()]
		.map(([cwd, entry]): ProjectStats => ({
			cwd,
			label: projectLabel(cwd),
			sessions: entry.sessions,
			total: entry.total,
			cost: entry.cost,
			share: grandTotal > 0 ? entry.total / grandTotal : 0,
		}))
		.sort((a, b) => b.total - a.total || b.sessions - a.sessions || a.label.localeCompare(b.label));
}

function streaks(days: readonly string[], now: number): { current: number; longest: number } {
	const unique = [...new Set(days)].sort();
	let longest = 0;
	let run = 0;
	let previous: Date | undefined;
	for (const day of unique) {
		const current = new Date(`${day}T12:00:00`);
		if (previous) {
			const expected = new Date(previous);
			expected.setDate(expected.getDate() + 1);
			run = localDay(expected.getTime()) === day ? run + 1 : 1;
		} else {
			run = 1;
		}
		longest = Math.max(longest, run);
		previous = current;
	}

	let current = 0;
	const set = new Set(unique);
	const cursor = new Date(now);
	cursor.setHours(12, 0, 0, 0);
	while (set.has(localDay(cursor.getTime()))) {
		current++;
		cursor.setDate(cursor.getDate() - 1);
	}
	return { current, longest };
}

function uniqueSessions(sessions: readonly SessionRecord[]): SessionRecord[] {
	const byId = new Map<string, SessionRecord>();
	for (const session of sessions) {
		const previous = byId.get(session.sessionId);
		if (!previous || session.lastActivityAt > previous.lastActivityAt) byId.set(session.sessionId, session);
	}
	return [...byId.values()];
}

export function buildSnapshot(
	index: StatsIndex,
	currentEntries: readonly unknown[],
	currentSessionId: string,
	range: StatsRange,
	now = Date.now(),
	currentSessionFile = "current-session.jsonl",
	toolSources: ReadonlyMap<string, string> = new Map(),
): StatsSnapshot {
	const cutoff = rangeStart(range, now);
	const periodRecords = range === "all"
		? index.usage
		: index.usage.filter((record) => record.timestamp >= cutoff && record.timestamp <= now);
	const dayTotals = new Map<string, number>();
	for (const record of index.usage) {
		if (record.timestamp <= 0) continue;
		const day = localDay(record.timestamp);
		dayTotals.set(day, (dayTotals.get(day) ?? 0) + totalTokens(record.usage));
	}
	const days = [...dayTotals.entries()]
		.map(([day, dayTotal]): DayStats => ({ day, total: dayTotal }))
		.sort((a, b) => a.day.localeCompare(b.day));
	const models = aggregateModels(periodRecords);
	const allModels = aggregateModels(index.usage);
	const sessions = uniqueSessions(index.sessions);
	const periodToolCalls = range === "all"
		? index.toolCalls
		: index.toolCalls.filter((record) => record.timestamp >= cutoff && record.timestamp <= now);
	const tools = aggregateTools(periodToolCalls, toolSources);
	const projects = aggregateProjects(sessions, new Set(index.usage.map((record) => record.fingerprint)), cutoff, now);
	const sessionPaths = new Set(index.sessions.map((session) => resolve(session.path)));
	const currentRecords = usageFromEntries(currentSessionId, currentEntries, now, currentSessionFile)
		.filter((record) => !hasPersistedSubagentChild(record, sessionPaths));
	const streak = streaks(days.map((day) => day.day), now);
	const mostActiveDay = days.reduce<DayStats | undefined>((best, day) => (!best || day.total > best.total ? day : best), undefined);

	return {
		range,
		allTime: total(index.usage),
		period: total(periodRecords),
		currentSession: total(currentRecords),
		models,
		tools,
		projects,
		days,
		sessionCount: sessions.length,
		mainSessionCount: sessions.filter((session) => session.source === "main").length,
		subagentSessionCount: sessions.filter((session) => session.source === "subagent").length,
		activeDays: days.length,
		currentStreak: streak.current,
		longestStreak: streak.longest,
		...(mostActiveDay ? { mostActiveDay } : {}),
		...(allModels[0] ? { favoriteModel: allModels[0].model } : {}),
		longestSessionMs: sessions.reduce(
			(longest, session) => Math.max(longest, session.createdAt > 0 ? Math.max(0, session.lastActivityAt - session.createdAt) : 0),
			0,
		),
		diagnostics: index.diagnostics,
	};
}

export function makeIndex(
	sessions: SessionRecord[],
	diagnostics: StatsIndex["diagnostics"],
	sidecar: UsageRecord[] = [],
): StatsIndex {
	return {
		sessions,
		usage: deduplicateUsage(sessions, sidecar),
		toolCalls: deduplicateToolCalls(sessions),
		diagnostics,
	};
}
