// A stand-in for `pi --mode rpc`: speaks just enough of the protocol for the
// manager tests. Prompt text drives behavior:
//   "ASK ..."  - forwards a select dialog from a running tool call and answers with the choice
//   "ORPHAN"   - forwards a dialog, then ends its tool call without waiting (a script that ended)
//   "EDIT ..." - forwards an editor dialog and answers with the result
//   "SLOW ..." - keeps running until a steer arrives, then answers with it
//   "FAIL ..." - ends with a provider error
//   "EXIT ..." - exits mid-run
//   "COMPACT"  - autocompact: stops its run, compacts, then continues the task
// Anything else answers "echo: <prompt>" after one tool call.
let buffer = "";
let pendingDialog;
let slow;
const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const usage = { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 1050, cost: { total: 0.01 } };

function finish(text, stopReason = "stop", errorMessage) {
	out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage, stopReason, ...(errorMessage ? { errorMessage } : {}) } });
	out({ type: "turn_end" });
	out({ type: "agent_end", messages: [] });
	out({ type: "agent_settled" });
}

function run(message) {
	out({ type: "agent_start" });
	out({ type: "message_end", message: { role: "user", content: message } });
	out({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls -la" } });
	out({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "file-a\nfile-b" }] }, isError: false });
	if (message.startsWith("ASK")) {
		pendingDialog = "d1";
		out({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "git push" } });
		out({ type: "extension_ui_request", id: "d1", method: "select", title: "Allow git push?", options: ["Allow", "Block"] });
		return;
	}
	if (message.startsWith("ORPHAN")) {
		out({ type: "tool_execution_start", toolCallId: "t9", toolName: "bash", args: { command: "git push" } });
		out({ type: "extension_ui_request", id: "d3", method: "select", title: "Allow git push?", options: ["Allow", "Block"] });
		setTimeout(() => {
			out({ type: "tool_execution_end", toolCallId: "t9", toolName: "bash", result: { content: [{ type: "text", text: "cancelled" }] }, isError: true });
			setTimeout(() => finish("orphaned"), 50);
		}, 50);
		return;
	}
	if (message.startsWith("EDIT")) {
		pendingDialog = "d2";
		out({ type: "extension_ui_request", id: "d2", method: "editor", title: "Edit plan", prefill: "x" });
		return;
	}
	if (message.startsWith("SLOW")) {
		slow = true;
		return;
	}
	if (message.startsWith("FAIL")) return finish("", "error", "529 overloaded");
	if (message.startsWith("EXIT")) process.exit(3);
	if (message.startsWith("COMPACT")) {
		out({ type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "pi-agents-compact", statusText: "compacting" });
		finish("", "aborted");
		setTimeout(() => {
			out({ type: "compaction_start", reason: "manual" });
			out({ type: "extension_ui_request", id: "s2", method: "setStatus", statusKey: "pi-agents-compact" });
			run("Compaction completed. Continue.");
		}, 50);
		return;
	}
	finish(`echo: ${message}`);
}

function handle(record) {
	switch (record.type) {
		case "get_state":
			out({ type: "response", id: record.id, command: "get_state", success: true, data: { sessionFile: `/tmp/fake-${process.pid}.jsonl` } });
			return;
		case "prompt":
			out({ type: "response", id: record.id, command: "prompt", success: true, data: { disposition: "started" } });
			setTimeout(() => run(record.message), 5);
			return;
		case "steer":
			out({ type: "response", id: record.id, command: "steer", success: true, data: { disposition: "queued" } });
			if (slow) {
				slow = false;
				setTimeout(() => {
					out({ type: "message_end", message: { role: "user", content: record.message } });
					finish(`steered: ${record.message}`);
				}, 5);
			}
			return;
		case "extension_ui_response":
			if (record.id === pendingDialog) {
				pendingDialog = undefined;
				if (record.id === "d1") out({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: { content: [] }, isError: false });
				finish(`dialog: ${record.cancelled ? "cancelled" : record.value}`);
			}
			return;
		case "abort":
			out({ type: "response", id: record.id, command: "abort", success: true });
			return;
	}
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line.trim()) handle(JSON.parse(line));
		index = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));
