import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type AgentSettledHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export function onAgentSettled(pi: ExtensionAPI, handler: AgentSettledHandler) {
	(
		pi as unknown as {
			on(event: "agent_settled", callback: AgentSettledHandler): void;
		}
	).on("agent_settled", handler);
}

export function isStaleExtensionContextError(error: unknown) {
	return (
		error instanceof Error &&
		(error.message.includes("This extension ctx is stale after session replacement or reload") ||
			error.message.includes("Extension context is no longer active"))
	);
}
