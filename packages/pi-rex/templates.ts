import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Template {
	/** Arguments after `pi` in the template's command. */
	args: string[];
	/** Instructions placed before the task. */
	body: string;
}

/** Split a command line on whitespace, honoring single and double quotes. */
export function splitCommand(command: string): string[] {
	const words: string[] = [];
	let word: string | undefined;
	let quote: string | undefined;
	for (const char of command) {
		if (quote) {
			if (char === quote) quote = undefined;
			else word = (word ?? "") + char;
		} else if (char === "'" || char === '"') {
			quote = char;
			word ??= "";
		} else if (/\s/.test(char)) {
			if (word !== undefined) words.push(word);
			word = undefined;
		} else word = (word ?? "") + char;
	}
	if (word !== undefined) words.push(word);
	return words;
}

/** A Markdown template: frontmatter with `command: pi …`, then instructions. The format herdr-core templates use. */
export function parseTemplate(source: string): Template {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
	if (!match) return { args: [], body: source.trim() };
	const command = /^command:\s*(.+)$/m.exec(match[1])?.[1]?.trim() ?? "pi";
	const [program, ...args] = splitCommand(command);
	if (program !== "pi") throw new Error(`template command must start with "pi", got "${program}"`);
	return { args, body: match[2].trim() };
}

export function templateDirs(agentDir: string): string[] {
	return [join(agentDir, "pi-rex", "templates"), join(homedir(), ".config", "herdr-core", "templates")];
}

export function loadTemplate(name: string, dirs: string[]): Template {
	if (!/^[\w.-]+$/.test(name)) throw new Error(`Invalid template name "${name}"`);
	for (const dir of dirs) {
		let source: string;
		try {
			source = readFileSync(join(dir, `${name}.md`), "utf8");
		} catch {
			continue;
		}
		return parseTemplate(source);
	}
	throw new Error(`No template "${name}" in ${dirs.join(" or ")}`);
}
