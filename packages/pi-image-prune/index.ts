import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, matchRule, type PruneConfig } from "./config.ts";
import {
	applyDrops,
	enforcePayloadLimit,
	estimateBytes,
	imageOccurrences,
	type Occurrence,
	prunePayload,
	selectImages,
	toItems,
	type TrimPolicy,
} from "./trim.ts";

// Claude Code 2.1.282 limits for the Anthropic Messages API, applied to models no rule matches.
const MIB = 1024 * 1024;
export const MAX_IMAGES = 100;
export const MAX_IMAGES_1M_CONTEXT = 600;
export const COUNT_DROP_BATCH = 20;
export const IMAGE_BYTE_CAP = 32 * MIB - 8 * MIB;
export const IMAGE_BYTE_TARGET = IMAGE_BYTE_CAP - 10 * MIB;
// Covers request framing a byte estimate of messages, prompt and tools does not see.
const REQUEST_OVERHEAD_BYTES = 8 * 1024;

type Model = NonNullable<ExtensionContext["model"]>;

function claudeCodeImageLimit(model: Model): number {
	return model.contextWindow > 200_000 ? MAX_IMAGES_1M_CONTEXT : MAX_IMAGES;
}

/** The policy for a model, or undefined to leave its requests alone. */
export function resolvePolicy(config: PruneConfig, model: Model | undefined): TrimPolicy | undefined {
	if (!model) return undefined;
	const anthropic = model.api === "anthropic-messages";
	const rule = matchRule(config.rules, model.provider, model.id);
	if (rule) {
		return {
			maxImages: rule.maxImages ?? (anthropic ? claudeCodeImageLimit(model) : Number.POSITIVE_INFINITY),
			dropBatch: COUNT_DROP_BATCH,
			maxBytes: rule.maxRequestBytes,
			targetBytes: rule.trimToBytes,
			countText: true,
		};
	}
	if (!anthropic) return undefined;
	return {
		maxImages: claudeCodeImageLimit(model),
		dropBatch: COUNT_DROP_BATCH,
		maxBytes: IMAGE_BYTE_CAP,
		targetBytes: IMAGE_BYTE_TARGET,
		countText: false,
	};
}

/** System prompt and active tool definitions: request bytes the context event does not carry. */
function promptAndToolBytes(pi: ExtensionAPI, ctx: ExtensionContext): number {
	let bytes = REQUEST_OVERHEAD_BYTES;
	try {
		bytes += Buffer.byteLength(ctx.getSystemPrompt?.() ?? "", "utf8");
		const active = new Set(pi.getActiveTools());
		const tools = pi
			.getAllTools()
			.filter((tool) => active.has(tool.name))
			.map(({ name, description, parameters }) => ({ name, description, parameters }));
		bytes += Buffer.byteLength(JSON.stringify(tools), "utf8");
	} catch {
		// An estimate only; the reserve above still applies.
	}
	return bytes;
}

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

export default function imagePrune(pi: ExtensionAPI): void {
	let config: PruneConfig = { rules: [] };
	let loaded = false;
	let lastDropped = 0;
	// Image occurrences from the latest context pass, for the finished payload.
	let occurrences = new Map<string, Occurrence[]>();
	let lastPayloadDropped = 0;

	const ensureConfig = (ctx: ExtensionContext) => {
		if (loaded) return;
		loaded = true;
		config = loadConfig();
		if (config.problem && ctx.hasUI) ctx.ui.notify(`pi-image-prune: ignoring config (${config.problem})`, "warning");
	};

	pi.on("session_start", (_event, ctx) => {
		loaded = false;
		lastDropped = 0;
		lastPayloadDropped = 0;
		occurrences = new Map();
		ensureConfig(ctx);
	});

	pi.on("context", (event, ctx) => {
		ensureConfig(ctx);
		const policy = resolvePolicy(config, ctx.model);
		occurrences = new Map();
		if (!policy) return;

		const items = toItems(event.messages);
		const baseBytes = policy.countText ? promptAndToolBytes(pi, ctx) : 0;
		const { dropped, unseen } = selectImages(items, policy, baseBytes);

		if (dropped.size > lastDropped && ctx.hasUI) {
			const size = policy.countText ? ` (request ≈ ${mb(estimateBytes(items, dropped, baseBytes))}, limit ${mb(policy.maxBytes)})` : "";
			ctx.ui.notify(`pi-image-prune: ${dropped.size} older image(s) left out of the request${size}`, "info");
		}
		lastDropped = dropped.size;

		occurrences = imageOccurrences(event.messages, dropped, unseen);
		const messages = applyDrops(event.messages, dropped, unseen);
		if (messages !== event.messages) return { messages };
	});

	pi.on("before_provider_request", (event, ctx) => {
		let payload = prunePayload(event.payload, occurrences);
		const policy = resolvePolicy(config, ctx.model);
		if (policy) {
			const enforced = enforcePayloadLimit(payload, policy, occurrences);
			if (enforced.dropped > lastPayloadDropped && ctx.hasUI) {
				ctx.ui.notify(`pi-image-prune: ${enforced.dropped} more image(s) left out to fit the finished request`, "info");
			}
			lastPayloadDropped = enforced.dropped;
			payload = enforced.payload;
		}
		if (payload !== event.payload) return payload;
	});
}
