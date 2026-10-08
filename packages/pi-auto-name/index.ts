/**
 * pi-auto-name — names the session after what it is about.
 *
 * When the first turn settles, and every second turn after that (1, 3, 5, …),
 * the session's own model reads a short digest of the branch (the user's
 * requests and the latest reply) and answers with a 3-5 word title, which
 * becomes the session name exactly as if set with `/name`. Automatic renames
 * only replace a name this extension set itself; `/rename` regenerates it on
 * demand and hands a hand-set name back to the automatic renames.
 *
 * The title request stands alone: nothing enters the transcript or the model's
 * context, and it shares no session id or prompt-cache entry with the session.
 * The only writes are the `session_info` entry `setSessionName` appends and a
 * `pi-auto-name` custom entry recording which name is ours; neither reaches
 * the model.
 *
 * Inside Herdr the name is also reported as the pane token `$session_name`
 * (see herdr.ts), so a sidebar row can show it without pi's title decoration.
 */
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveGuardianCompleteSimple } from "./guardian-transport.ts";
import { reportSessionName } from "./herdr.ts";

const MAX_TITLE_CHARS = 40;
const MAX_EXCERPT_CHARS = 400;
const RECENT_REQUESTS = 3;
const TIMEOUT_MS = 30_000;
const STATUS_KEY = "pi-auto-name";
const OWNED_ENTRY = "pi-auto-name";

const SYSTEM_PROMPT = [
	"You name coding-agent sessions so the user can tell them apart.",
	"Reply with ONLY a 3-5 word title for the work in this session:",
	"lowercase unless a proper noun, no quotes, no trailing punctuation.",
	'Name the task itself (e.g. "statusline cache fix", "herdr pane auto-title"), not the tools or the assistant.',
].join(" ");

// Injected reminders arrive as user messages but are not what the user asked.
const SYNTHETIC = /^\s*(<system|\[system|system-reminder)/i;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

function clip(text: string, limit = MAX_EXCERPT_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** The first request, the last few, and the latest reply on the current branch. */
export function buildDigest(entries: readonly unknown[], cwd: string): string | undefined {
	const requests: string[] = [];
	let reply: string | undefined;
	for (const entry of entries as Array<{ type?: string; message?: { role?: string; content?: unknown } }>) {
		if (entry?.type !== "message") continue;
		const text = textOf(entry.message?.content).trim();
		if (!text) continue;
		if (entry.message?.role === "user" && !SYNTHETIC.test(text)) requests.push(text);
		else if (entry.message?.role === "assistant") reply = text;
	}
	if (requests.length === 0) return undefined;
	const lines = [`Project directory: ${path.basename(cwd) || cwd}`, `First request: ${clip(requests[0])}`];
	for (const request of requests.slice(1).slice(-RECENT_REQUESTS)) lines.push(`Recent request: ${clip(request)}`);
	if (reply) lines.push(`Latest reply: ${clip(reply)}`);
	return lines.join("\n");
}

/** The last name this extension set on the branch, so ownership survives resume and fork. */
export function lastAutoName(entries: readonly unknown[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; customType?: string; data?: { name?: unknown } };
		if (entry?.type === "custom" && entry.customType === OWNED_ENTRY && typeof entry.data?.name === "string") return entry.data.name;
	}
	return undefined;
}

export function sanitizeTitle(raw: string): string | undefined {
	const line = raw.split("\n").find((candidate) => candidate.trim()) ?? "";
	let title = line
		.replace(/^\s*title\s*:\s*/i, "")
		.replace(/^[\s"'`*#]+|[\s"'`*.!?:;,]+$/g, "")
		.replace(/\s+/g, " ");
	if (title.length > MAX_TITLE_CHARS) {
		const cut = title.slice(0, MAX_TITLE_CHARS);
		const space = cut.lastIndexOf(" ");
		title = space > MAX_TITLE_CHARS / 2 ? cut.slice(0, space) : cut;
	}
	return title || undefined;
}

async function generateTitle(ctx: ExtensionContext, thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>, signal: AbortSignal): Promise<string> {
	const model = ctx.model;
	if (!model) throw new Error("no model selected");
	const digest = buildDigest(ctx.sessionManager.getBranch(), ctx.cwd);
	if (!digest) throw new Error("nothing to name yet");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	// Same thinking level as the session. No session id and no cache retention
	// keep this request clear of the session's cache.
	const reasoning = model.reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {};
	const response = await resolveGuardianCompleteSimple(ctx.modelRegistry, "pi-auto-name")(
		model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [{ role: "user", content: digest, timestamp: Date.now() }] },
		{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal, transport: "sse", cacheRetention: "none", ...reasoning },
	);
	if (response.stopReason === "error") throw new Error(response.errorMessage ?? "model request failed");
	const title = sanitizeTitle(textOf(response.content));
	if (!title) throw new Error("the model returned no title");
	return title;
}

export default function autoName(pi: ExtensionAPI): void {
	let inFlight: AbortController | undefined;
	let settledTurns = 0;

	const cancel = () => {
		inFlight?.abort();
		inFlight = undefined;
	};

	/** Resolves to the applied title, or undefined when superseded or skipped. */
	async function rename(ctx: ExtensionContext, automatic: boolean): Promise<string | undefined> {
		cancel();
		const before = pi.getSessionName();
		const own = new AbortController();
		inFlight = own;
		const timer = setTimeout(() => own.abort(), TIMEOUT_MS);
		timer.unref?.();
		try {
			const title = await generateTitle(ctx, pi.getThinkingLevel(), own.signal);
			// A `/name` during the request wins over an automatic title.
			if (own.signal.aborted || (automatic && pi.getSessionName() !== before)) return undefined;
			if (title !== before) pi.setSessionName(title);
			if (title !== lastAutoName(ctx.sessionManager.getBranch())) pi.appendEntry(OWNED_ENTRY, { name: title });
			return title;
		} catch (error) {
			if (own.signal.aborted) return undefined;
			throw error;
		} finally {
			clearTimeout(timer);
			if (inFlight === own) inFlight = undefined;
		}
	}

	// Herdr gets the name on every session change (so a stale one never carries
	// over), on every rename, and a clear on quit. TUI only, like the auto name.
	pi.on("session_start", (_event, ctx) => {
		cancel();
		settledTurns = 0;
		if (ctx.mode === "tui") void reportSessionName(pi.getSessionName());
	});
	pi.on("session_info_changed", (event, ctx) => {
		if (ctx.mode === "tui") void reportSessionName(event.name);
	});
	pi.on("session_shutdown", async (event, ctx) => {
		cancel();
		if (event.reason === "quit" && ctx.mode === "tui") await reportSessionName(undefined);
	});

	// Turns 1, 3, 5, … of each session, and only while the name is unset or ours:
	// a name from `/name` or set before this extension ran is never replaced.
	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		settledTurns++;
		if (settledTurns % 2 === 0 || inFlight) return;
		const branch = ctx.sessionManager.getBranch();
		const name = pi.getSessionName();
		if (name && name !== lastAutoName(branch)) return;
		if (!buildDigest(branch, ctx.cwd)) return;
		try {
			await rename(ctx, true);
		} catch {
			// Cosmetic: a failed title keeps the old name until the next attempt.
		}
	});

	pi.registerCommand("rename", {
		description: "Regenerate the session name from the conversation",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus(STATUS_KEY, "naming session…");
			try {
				const title = await rename(ctx, false);
				if (title) ctx.ui.notify(`Session renamed: ${title}`, "info");
			} catch (error) {
				ctx.ui.notify(`Rename failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});
}
