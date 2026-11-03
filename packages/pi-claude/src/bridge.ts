import { randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: unknown[];
  isError?: boolean;
}

/** A `tools/call` from Claude Code, held open until Pi supplies the tool's real result. */
export interface ParkedCall {
  name: string;
  arguments: Record<string, unknown>;
  /** Claude Code passes the model's tool_use id in `_meta`; absent on older versions. */
  toolUseId?: string;
  respond(result: McpCallResult): void;
}

let privateRoot: Promise<string> | undefined;
let privateRootPath: string | undefined;

/** One 0700 directory per Pi process for sockets and per-worker launch files. */
export function privateDirectory(): Promise<string> {
  privateRoot ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-claude-"));
    await chmod(dir, 0o700);
    privateRootPath = dir;
    return dir;
  })();
  return privateRoot;
}

export function removePrivateDirectorySync(): void {
  const root = privateRootPath;
  privateRoot = undefined;
  privateRootPath = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The extension side of the MCP bridge: a private Unix socket that the shipped
 * `mcp-bridge.mjs` relays Claude Code's JSON-RPC to. Implements just enough of
 * MCP for a tools-only server.
 */
export class McpBridge {
  readonly token = randomBytes(24).toString("hex");
  private server?: Server;
  private sockets = new Set<Socket>();
  private closed = false;

  constructor(
    readonly socketPath: string,
    private tools: McpTool[],
    private readonly onCall: (call: ParkedCall) => void,
  ) {}

  static async start(dir: string, tools: McpTool[], onCall: (call: ParkedCall) => void): Promise<McpBridge> {
    const bridge = new McpBridge(join(dir, `b-${randomBytes(6).toString("hex")}.sock`), tools, onCall);
    await bridge.listen();
    return bridge;
  }

  private listen(): Promise<void> {
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        void chmod(this.socketPath, 0o600).catch(() => undefined);
        resolve();
      });
    });
  }

  private accept(socket: Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => undefined);
    let authenticated = false;
    const send = (message: unknown) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    };
    createInterface({ input: socket, crlfDelay: Infinity }).on("line", (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!authenticated) {
        if (typeof message.hello === "string" && sameToken(message.hello, this.token)) authenticated = true;
        else socket.destroy();
        return;
      }
      this.handle(message, send);
    });
  }

  private handle(message: Record<string, unknown>, send: (message: unknown) => void): void {
    const id = message.id as string | number | undefined;
    const method = message.method;
    if (id === undefined || id === null) return; // notifications
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id, result });
    const params = (message.params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "initialize":
        reply({
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "pi", version: "1" },
        });
        return;
      case "ping":
        reply({});
        return;
      case "tools/list":
        reply({ tools: this.tools });
        return;
      case "tools/call": {
        const meta = (params._meta ?? {}) as Record<string, unknown>;
        const toolUseId = meta["claudecode/toolUseId"];
        let answered = false;
        this.onCall({
          name: String(params.name ?? ""),
          arguments: (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<
            string,
            unknown
          >,
          toolUseId: typeof toolUseId === "string" ? toolUseId : undefined,
          respond: (result) => {
            if (answered) return;
            answered = true;
            reply(result);
          },
        });
        return;
      }
      default:
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(method)}` } });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await rm(this.socketPath, { force: true }).catch(() => undefined);
  }
}
