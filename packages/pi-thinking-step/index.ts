/**
 * pi-thinking-step — step the thinking level up or down one notch with
 * Alt+= / Alt+-, instead of cycling through every level with Shift+Tab.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];

export const UP_KEY = "alt+=";
export const DOWN_KEY = "alt+-";

export default function thinkingStepExtension(pi: ExtensionAPI): void {
	const step = (dir: 1 | -1) => (ctx: ExtensionContext) => {
		const start = pi.getThinkingLevel() as Level;
		let i = LEVELS.indexOf(start);
		// setThinkingLevel clamps to the model; keep stepping past unsupported levels
		while ((i += dir) >= 0 && i < LEVELS.length) {
			pi.setThinkingLevel(LEVELS[i]);
			if (pi.getThinkingLevel() !== start) break;
		}
		const now = pi.getThinkingLevel();
		if (ctx.hasUI) ctx.ui.notify(now === start ? `Thinking: ${now} (limit)` : `Thinking: ${now}`, "info");
	};

	pi.registerShortcut(UP_KEY, { description: "Thinking level up", handler: step(1) });
	pi.registerShortcut(DOWN_KEY, { description: "Thinking level down", handler: step(-1) });
}
