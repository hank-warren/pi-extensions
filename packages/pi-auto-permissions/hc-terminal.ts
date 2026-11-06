/**
 * Which herdr-core (`hc`) terminal this session runs in, and which terminal
 * started it. hc delivers another agent's message as a user message wrapped
 * in `<hc from="t7 …">`; the reviewer needs the parent to tell a request
 * relayed from the agent that started this session (which its own reviewer
 * checked against its user's messages) from any other agent's message.
 *
 * hc sets HC_TERMINAL_ID but no parent variable, so the parent comes from
 * `hc get`. Any failure leaves the parent unknown, and then no hc message can
 * authorize anything.
 */
import { execFile } from "node:child_process";

export interface HcTerminal {
  id: string;
  parent?: string;
}

const ADDRESS = /^[\w.-]+(?:\/[\w.-]+)?$/;
const LOOKUP_TIMEOUT_MS = 3000;

type RunHc = (args: string[]) => Promise<string>;

function runHc(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("hc", args, { timeout: LOOKUP_TIMEOUT_MS, maxBuffer: 1 << 20 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** This session's terminal from the environment alone, with its parent not yet known. */
export function hcTerminalFromEnv(env: NodeJS.ProcessEnv = process.env): HcTerminal | undefined {
  const id = env.HC_TERMINAL_ID;
  return id && ADDRESS.test(id) ? { id } : undefined;
}

export async function detectHcTerminal(
  env: NodeJS.ProcessEnv = process.env,
  run: RunHc = runHc,
): Promise<HcTerminal | undefined> {
  const id = hcTerminalFromEnv(env)?.id;
  if (!id) return undefined;
  try {
    const parsed = JSON.parse(await run(["get", id, "--json"])) as { parent?: unknown };
    const parent = typeof parsed.parent === "string" && ADDRESS.test(parsed.parent) ? parsed.parent : undefined;
    return parent ? { id, parent } : { id };
  } catch {
    return { id };
  }
}

const HC_TAG = /^\s*<hc\b([^>]*)>/;
const FROM = /\bfrom="([^"\s]+)[^"]*"/;

/**
 * How the reviewer should read a user message in an hc session: from the
 * parent terminal (`relayed`), from any other terminal or from hc itself
 * (`agent`), or not an hc message at all (undefined).
 */
export function classifyHcMessage(
  text: string,
  terminal: HcTerminal,
): { kind: "relayed" | "agent"; from: string } | undefined {
  const tag = HC_TAG.exec(text);
  if (!tag) return undefined;
  const from = FROM.exec(tag[1] ?? "")?.[1] ?? "hc";
  return { kind: terminal.parent !== undefined && from === terminal.parent ? "relayed" : "agent", from };
}
