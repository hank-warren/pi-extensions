/**
 * pi-TEMPLATE — minimal public Pi package skeleton.
 *
 * Replace this header, the example tool, and every TEMPLATE placeholder in
 * package.json / README.md / LICENSE with the real package.
 *
 * Extensions are TypeScript loaded by Pi directly (no build step). The entry
 * point default-exports a function receiving the ExtensionAPI.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function templateExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "template_greet",
		label: "Template Greet",
		description:
			"Template example tool: returns a fixed greeting. Replace with the real implementation.",
		parameters: Type.Object({
			name: Type.String({
				minLength: 1,
				maxLength: 200,
				description: "Name to greet.",
			}),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: `hello, ${params.name}` }],
				details: { name: params.name },
			};
		},
	});
}
