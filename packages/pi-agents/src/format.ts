/** Compact magnitudes: 999, 1.5k, 41k, 1.2M. */
export function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "0";
	if (n < 1_000) return `${Math.round(n)}`;
	if (n < 999_950) {
		const k = n / 1_000;
		return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
	}
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** 42s, 2m05s, 1h03m. */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Collapse whitespace and cut to `max` characters. */
export function oneLine(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** The first line of a codemode script that is not an options/comment line. */
function firstCodeLine(code: string): string {
	for (const line of code.split("\n")) {
		const trimmed = line.trim();
		if (trimmed && !trimmed.startsWith("//")) return trimmed;
	}
	return "";
}

/** A tool call in Pi's own notation, split so a renderer can style the head like Pi does. */
export interface ToolCallSummary {
	/** `$`, `read`, `grep`… — Pi renders this part in the tool-title style. */
	head: string;
	rest: string;
}

/** One-line summary of a tool call, written the way Pi's built-in renderers write it: `$ rg -n foo`, `read src/a.ts:10-40`. */
export function summarizeToolCall(name: string, args: unknown): ToolCallSummary {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const str = (key: string): string | undefined => (typeof record[key] === "string" ? (record[key] as string) : undefined);
	const num = (key: string): number | undefined => (typeof record[key] === "number" ? (record[key] as number) : undefined);
	const path = str("path") ?? str("file_path") ?? "";
	switch (name) {
		case "bash":
			return { head: "$", rest: oneLine(str("command") ?? "", 100) };
		case "read": {
			const offset = num("offset");
			const limit = num("limit");
			const range = offset !== undefined ? `:${offset}${limit !== undefined ? `-${offset + limit - 1}` : ""}` : "";
			return { head: "read", rest: `${path}${range}` };
		}
		case "edit":
		case "write":
		case "ls":
			return { head: name, rest: path || (name === "ls" ? "." : "") };
		case "grep":
			return { head: "grep", rest: `/${oneLine(str("pattern") ?? "", 60)}/${path ? ` in ${path}` : ""}` };
		case "find":
			return { head: "find", rest: `${oneLine(str("pattern") ?? "", 60)}${path ? ` in ${path}` : ""}` };
		case "codemode":
			return { head: "codemode", rest: oneLine(firstCodeLine(str("code") ?? ""), 90) };
		default: {
			const first = Object.values(record).find((value): value is string => typeof value === "string");
			return { head: name, rest: first ? oneLine(first, 90) : "" };
		}
	}
}

export function summaryText(summary: ToolCallSummary): string {
	return summary.rest ? `${summary.head} ${summary.rest}` : summary.head;
}

/** Text of a message `content` value (string or content blocks), text blocks only. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } =>
			Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** Cut a long result, keeping the start, and say how much was dropped. */
export function capText(text: string, max: number): { text: string; dropped: number } {
	if (text.length <= max) return { text, dropped: 0 };
	return { text: text.slice(0, max), dropped: text.length - max };
}
