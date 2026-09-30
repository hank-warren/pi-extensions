/**
 * Reports the session name to Herdr as the pane metadata token `session_name`,
 * so a Herdr sidebar row can show it as `$session_name`. Display-only: it does
 * not touch Herdr's agent state or pi's terminal title.
 *
 * Defensive by design: a no-op outside a Herdr pane, one short-lived socket
 * write per report, bounded by a timeout, and every failure is swallowed.
 */
import net from "node:net";

const SOURCE = "pi-auto-name";
const TOKEN = "session_name";
const TIMEOUT_MS = 500;

// Herdr ignores reports whose seq is not newer than the last one from this
// source, so a late write can never restore an older name. Time-based so a
// restarted pi in the same pane still counts as newer.
let seq = Date.now() * 1000;

function endpoint(): { socket: string; pane: string } | undefined {
	const { HERDR_ENV, HERDR_SOCKET_PATH, HERDR_PANE_ID } = process.env;
	if (HERDR_ENV !== "1" || !HERDR_SOCKET_PATH || !HERDR_PANE_ID) return undefined;
	const socket = process.platform === "win32" ? `\\\\.\\pipe\\${HERDR_SOCKET_PATH}` : HERDR_SOCKET_PATH;
	return { socket, pane: HERDR_PANE_ID };
}

/** Sets (or, with no name, clears) the pane's `session_name` token. Never throws. */
export function reportSessionName(name: string | undefined): Promise<void> {
	const target = endpoint();
	if (!target) return Promise.resolve();
	const request = {
		id: `${SOURCE}:${Date.now()}`,
		method: "pane.report_metadata",
		params: { pane_id: target.pane, source: SOURCE, seq: ++seq, tokens: { [TOKEN]: name?.trim() || null } },
	};
	return new Promise((resolve) => {
		let socket: net.Socket | undefined;
		const finish = () => {
			clearTimeout(timer);
			socket?.destroy();
			resolve();
		};
		const timer = setTimeout(finish, TIMEOUT_MS);
		timer.unref?.();
		try {
			socket = net.createConnection(target.socket);
			socket.on("connect", () => socket?.write(`${JSON.stringify(request)}\n`));
			socket.on("data", finish);
			socket.on("error", finish);
			socket.on("close", finish);
		} catch {
			finish();
		}
	});
}
