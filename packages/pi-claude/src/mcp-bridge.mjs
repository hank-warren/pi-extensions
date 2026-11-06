#!/usr/bin/env node
// Stdio MCP server that Claude Code launches. It only relays newline-delimited
// JSON-RPC between Claude Code and the Pi extension over a private Unix socket;
// the extension answers every request, and parks tool calls until Pi has run them.
import { connect } from "node:net";

const socketPath = process.env.PI_CLAUDE_BRIDGE_SOCKET;
const token = process.env.PI_CLAUDE_BRIDGE_TOKEN;
if (!socketPath || !token) {
  process.stderr.write("pi-claude MCP bridge: missing socket configuration\n");
  process.exit(2);
}

const socket = connect(socketPath);
socket.setNoDelay?.(true);
socket.on("connect", () => {
  socket.write(`${JSON.stringify({ hello: token })}\n`);
  process.stdin.pipe(socket);
});
socket.pipe(process.stdout);
socket.on("error", (error) => {
  process.stderr.write(`pi-claude MCP bridge: ${error.message}\n`);
  process.exit(1);
});
socket.on("close", () => process.exit(0));
process.stdin.on("end", () => socket.end());
