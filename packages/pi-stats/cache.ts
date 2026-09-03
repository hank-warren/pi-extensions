import { randomUUID } from "node:crypto";
import { readFile, readdir, realpath, rename, stat, writeFile, mkdir, chmod, unlink } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { makeIndex, parseSessionText, parseUsageSidecar } from "./stats.ts";
import type { CachedFileRecord, ScanDiagnostics, SessionRecord, StatsCacheFile, StatsIndex, UsageRecord } from "./types.ts";

/** Bumped to 3 when tool-call records were added; older caches lack them and must be reparsed. */
const CACHE_VERSION = 3 as const;
const SKIP_DIRECTORIES = new Set(["subagent-artifacts"]);
/** Extensions record out-of-transcript model usage in <agentDir>/<extension>/usage.jsonl. */
const USAGE_SIDECAR_NAMES = new Set(["usage.jsonl", "usage.jsonl.1"]);

interface ScanOptions {
	agentDir: string;
	activeSessionDir?: string;
	env?: NodeJS.ProcessEnv;
	sessionRoots?: string[];
	force?: boolean;
	signal?: AbortSignal;
	onProgress?: (completed: number, total: number) => void;
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

async function settingsSubagentRoot(agentDir: string): Promise<string | undefined> {
	try {
		const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as unknown;
		if (!settings || typeof settings !== "object") return undefined;
		const subagents = (settings as { subagents?: unknown }).subagents;
		if (!subagents || typeof subagents !== "object") return undefined;
		const configured = (subagents as { defaultSessionDir?: unknown }).defaultSessionDir;
		return typeof configured === "string" && configured.length > 0 ? expandHome(configured) : undefined;
	} catch {
		return undefined;
	}
}

export async function resolveSessionRoots(options: ScanOptions): Promise<string[]> {
	if (options.sessionRoots) return uniqueExistingDirectories(options.sessionRoots);
	const env = options.env ?? process.env;
	const roots = [join(options.agentDir, "sessions")];
	if (env.PI_CODING_AGENT_SESSION_DIR) roots.push(expandHome(env.PI_CODING_AGENT_SESSION_DIR));
	if (options.activeSessionDir) roots.push(options.activeSessionDir);
	const configuredSubagents = await settingsSubagentRoot(options.agentDir);
	if (configuredSubagents) roots.push(configuredSubagents);
	if (env.PI_STATS_SESSION_DIRS) {
		roots.push(...env.PI_STATS_SESSION_DIRS.split(delimiter).filter(Boolean).map(expandHome));
	}
	return uniqueExistingDirectories(roots);
}

async function uniqueExistingDirectories(paths: string[]): Promise<string[]> {
	const result = new Set<string>();
	for (const candidate of paths) {
		try {
			const resolved = await realpath(resolve(candidate));
			if ((await stat(resolved)).isDirectory()) result.add(resolved);
		} catch {
			// Missing optional roots are expected.
		}
	}
	return [...result];
}

async function discoverJsonlFiles(roots: readonly string[], signal?: AbortSignal): Promise<string[]> {
	const found = new Set<string>();
	const walk = async (directory: string): Promise<void> => {
		signal?.throwIfAborted();
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			signal?.throwIfAborted();
			if (entry.isSymbolicLink()) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRECTORIES.has(entry.name)) await walk(path);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				try {
					found.add(await realpath(path));
				} catch {
					// File disappeared between directory listing and resolution.
				}
			}
		}
	};
	for (const root of roots) await walk(root);
	return [...found].sort();
}

/** One level below the agent directory only; sidecars are a flat, documented convention. */
async function discoverUsageSidecars(agentDir: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string[]> {
	if (env.PI_STATS_DISABLE_USAGE_SIDECARS === "1") return [];
	const found = new Set<string>();
	let directories;
	try {
		directories = await readdir(agentDir, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const directory of directories) {
		signal?.throwIfAborted();
		if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
		let entries;
		try {
			entries = await readdir(join(agentDir, directory.name), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || entry.isSymbolicLink() || !USAGE_SIDECAR_NAMES.has(entry.name)) continue;
			try {
				found.add(await realpath(join(agentDir, directory.name, entry.name)));
			} catch {
				// File disappeared between listing and resolution.
			}
		}
	}
	return [...found].sort();
}

function emptyCache(): StatsCacheFile {
	return { version: CACHE_VERSION, files: {} };
}

function validNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validUsageRecord(value: unknown): value is UsageRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<UsageRecord>;
	const usage = record.usage as Partial<UsageRecord["usage"]> | undefined;
	return (
		typeof record.fingerprint === "string" &&
		validNumber(record.timestamp) &&
		typeof record.model === "string" &&
		(record.kind === "assistant" || record.kind === "tool" || record.kind === "summary" || record.kind === "sidecar") &&
		Boolean(usage) &&
		validNumber(usage?.input) &&
		validNumber(usage?.output) &&
		validNumber(usage?.cacheRead) &&
		validNumber(usage?.cacheWrite) &&
		validNumber(usage?.reasoning) &&
		validNumber(usage?.cost) &&
		validNumber(usage?.calls) &&
		(record.childSessionFiles === undefined || (Array.isArray(record.childSessionFiles) && record.childSessionFiles.every((file) => typeof file === "string")))
	);
}

function validSessionRecord(value: unknown): value is SessionRecord {
	if (!value || typeof value !== "object") return false;
	const session = value as Partial<SessionRecord>;
	return (
		typeof session.path === "string" &&
		typeof session.sessionId === "string" &&
		typeof session.cwd === "string" &&
		validNumber(session.createdAt) &&
		validNumber(session.lastActivityAt) &&
		(session.source === "main" || session.source === "subagent") &&
		Array.isArray(session.usage) &&
		session.usage.every(validUsageRecord)
	);
}

function validCache(value: unknown): value is StatsCacheFile {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<StatsCacheFile>;
	if (candidate.version !== CACHE_VERSION || !candidate.files || typeof candidate.files !== "object") return false;
	return Object.entries(candidate.files).every(([path, value]) => {
		if (!path || !value || typeof value !== "object") return false;
		const record = value as Partial<CachedFileRecord>;
		return (
			validNumber(record.size) &&
			validNumber(record.mtimeMs) &&
			validNumber(record.malformedLines) &&
			(record.ignored === undefined || record.ignored === true) &&
			(record.session === undefined || validSessionRecord(record.session)) &&
			(record.sidecar === undefined || (Array.isArray(record.sidecar) && record.sidecar.every(validUsageRecord)))
		);
	});
}

async function loadCache(path: string): Promise<{ cache: StatsCacheFile; valid: boolean }> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (!validCache(parsed)) return { cache: emptyCache(), valid: false };
		return { cache: parsed, valid: true };
	} catch {
		return { cache: emptyCache(), valid: false };
	}
}

async function cleanupStaleTemporaryFiles(path: string): Promise<void> {
	const directory = dirname(path);
	const prefix = `${basename(path)}.`;
	const cutoff = Date.now() - 24 * 60 * 60 * 1000;
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		await Promise.all(entries.map(async (entry) => {
			if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".tmp")) return;
			const candidate = join(directory, entry.name);
			try {
				if ((await stat(candidate)).mtimeMs < cutoff) await unlink(candidate);
			} catch {
				// Another process may already have removed it.
			}
		}));
	} catch {
		// The cache directory may not exist yet.
	}
}

async function atomicWriteCache(path: string, cache: StatsCacheFile): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(cache), { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
		await chmod(path, 0o600);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

function sameFile(record: CachedFileRecord | undefined, size: number, mtimeMs: number): boolean {
	return Boolean(record && record.size === size && record.mtimeMs === mtimeMs);
}

export function statsCachePath(agentDir: string): string {
	return join(agentDir, "pi-stats", "cache.json");
}

export async function mapConcurrentOrdered<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
	onProgress?: (completed: number, total: number) => void,
	signal?: AbortSignal,
): Promise<R[]> {
	if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("concurrency limit must be positive");
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	let completed = 0;
	// The first failure (an abort, a worker throw, or a progress callback that
	// throws) stops work being assigned and stops anything else being published,
	// but never abandons work already in flight: the caller's `catch` must not
	// run while file reads are still landing in `results` and progress is still
	// being reported into a widget that is about to be torn down.
	let failure: unknown;
	const failed = () => failure !== undefined;
	const run = async () => {
		while (!failed()) {
			try {
				signal?.throwIfAborted();
			} catch (error) {
				failure ??= error;
				return;
			}
			const index = nextIndex;
			if (index >= items.length) return;
			nextIndex += 1;
			try {
				const value = await worker(items[index]!, index);
				// Re-check *after* the await: an abort during the read must not still
				// publish a result or a progress tick into a dashboard that is being
				// torn down. A sibling runner may not have noticed the abort yet.
				signal?.throwIfAborted();
				if (failed()) return;
				results[index] = value;
				completed += 1;
				onProgress?.(completed, items.length);
			} catch (error) {
				failure ??= error;
				return;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
	if (failed()) throw failure;
	return results;
}

type ScannedFile = {
	file: string;
	record?: CachedFileRecord;
	reused: boolean;
	unreadable: boolean;
	changed: boolean;
};

export async function scanStats(options: ScanOptions): Promise<StatsIndex> {
	const roots = await resolveSessionRoots(options);
	const sessionFiles = await discoverJsonlFiles(roots, options.signal);
	const sidecarFiles = await discoverUsageSidecars(options.agentDir, options.env ?? process.env, options.signal);
	const sidecars = new Set(sidecarFiles);
	const files = [...sessionFiles.filter((file) => !sidecars.has(file)), ...sidecarFiles];
	const cachePath = statsCachePath(options.agentDir);
	await cleanupStaleTemporaryFiles(cachePath);
	const loaded = options.force ? { cache: emptyCache(), valid: false } : await loadCache(cachePath);
	const next: StatsCacheFile = emptyCache();
	const diagnostics: ScanDiagnostics = {
		discoveredFiles: files.length,
		parsedFiles: 0,
		reusedFiles: 0,
		ignoredFiles: 0,
		unreadableFiles: 0,
		malformedLines: 0,
	};
	let changed = options.force === true || !loaded.valid;

	const scanned = await mapConcurrentOrdered(
		files,
		8,
		async (file): Promise<ScannedFile> => {
			options.signal?.throwIfAborted();
			try {
				const metadata = await stat(file);
				const previous = loaded.cache.files[file];
				if (!options.force && sameFile(previous, metadata.size, metadata.mtimeMs)) {
					return { file, record: previous!, reused: true, unreadable: false, changed: false };
				}
				if (sidecars.has(file)) {
					const parsed = parseUsageSidecar(file, await readFile(file, "utf8"));
					return {
						file,
						record: {
							size: metadata.size,
							mtimeMs: metadata.mtimeMs,
							sidecar: parsed.records,
							malformedLines: parsed.malformedLines,
						},
						reused: false,
						unreadable: false,
						changed: true,
					};
				}
				const parsed = parseSessionText(file, await readFile(file, "utf8"));
				return {
					file,
					record: {
						size: metadata.size,
						mtimeMs: metadata.mtimeMs,
						...(parsed.ignored ? { ignored: true as const } : {}),
						...(parsed.session ? { session: parsed.session } : {}),
						malformedLines: parsed.malformedLines,
					},
					reused: false,
					unreadable: false,
					changed: true,
				};
			} catch {
				options.signal?.throwIfAborted();
				return { file, reused: false, unreadable: true, changed: true };
			}
		},
		options.onProgress,
		options.signal,
	);

	for (const result of scanned) {
		if (result.record) {
			next.files[result.file] = result.record;
			if (result.reused) diagnostics.reusedFiles++;
			else diagnostics.parsedFiles++;
			if (result.record.ignored) diagnostics.ignoredFiles++;
			diagnostics.malformedLines += result.record.malformedLines;
		}
		if (result.unreadable) diagnostics.unreadableFiles++;
		if (result.changed) changed = true;
	}

	if (Object.keys(loaded.cache.files).some((file) => !(file in next.files))) changed = true;
	if (changed) {
		await atomicWriteCache(cachePath, next).catch(() => {
			// Stats remain usable if the optional cache cannot be written.
		});
	}
	const sessions = Object.values(next.files).flatMap((record) => (record.session ? [record.session] : []));
	const sidecarUsage = Object.values(next.files).flatMap((record) => record.sidecar ?? []);
	return makeIndex(sessions, diagnostics, sidecarUsage);
}

export function isExternalSessionDirectory(activeSessionDir: string, agentDir: string): boolean {
	const standard = resolve(agentDir, "sessions");
	const active = resolve(activeSessionDir);
	return active !== standard && !active.startsWith(`${standard}/`);
}

