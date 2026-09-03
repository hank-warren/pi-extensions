import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineMenu, type RunMenuResult, runMenu } from "@narumitw/pi-tui-kit";
import { planExportDestination } from "./plan-export.js";
import {
	configuredPlanExportPath,
	type PlanModeSettings,
	type PlanModeSettingsLoadResult,
	type PlanModeSettingsPatch,
	planModeSettingsPath,
	readPlanModeSettings,
	type UpdatePlanModeSettingsOptions,
	updatePlanModeSettings,
} from "./settings.js";

interface SettingsMenuState {
	kind: "valid" | "invalid";
	settings: PlanModeSettings;
	reason?: string;
}

interface PlanModeSettingsMenuOptions {
	signal: AbortSignal;
	isCurrent(): boolean;
	settingsPath?: string;
	readSettings?: (settingsPath?: string) => Promise<PlanModeSettingsLoadResult>;
	updateSettings?: (
		patch: PlanModeSettingsPatch,
		options?: UpdatePlanModeSettingsOptions,
	) => Promise<PlanModeSettings>;
	onSaved(settings: PlanModeSettings): void;
}

type Screen = "settings" | "export";
type Action = "open-export" | "set-export";

export async function showPlanModeSettings(
	ctx: ExtensionContext,
	options: PlanModeSettingsMenuOptions,
): Promise<RunMenuResult> {
	const settingsPath = options.settingsPath ?? planModeSettingsPath();
	const readSettings = options.readSettings ?? readPlanModeSettings;
	const updateSettings = options.updateSettings ?? updatePlanModeSettings;

	const loadState = async (): Promise<SettingsMenuState> => {
		const loaded = await readSettings(options.settingsPath);
		if (loaded.kind === "invalid") {
			return { kind: "invalid", settings: {}, reason: loaded.reason };
		}
		return { kind: "valid", settings: loaded.kind === "loaded" ? loaded.settings : {} };
	};

	const menu = defineMenu<SettingsMenuState, Screen, Action, ExtensionContext>({
		start: "settings",
		screens: {
			settings: ({ state }) =>
				state.kind === "invalid"
					? invalidScreen(settingsPath, state)
					: {
							kind: "settings",
							title: "Plan Mode Settings",
							lines: settingsLines(settingsPath),
							items: [
								{
									id: "defaultPlanExportPath",
									label: "Export destination",
									description: "Set the destination used when an export omits its path.",
									currentValue: safeTerminalText(configuredPlanExportPath(state.settings)),
									action: "open-export",
								},
							],
						},
			export: ({ state }) => {
				const configured = configuredPlanExportPath(state.settings);
				const destination = planExportDestination(configured, ctx.cwd);
				return {
					kind: "input",
					title: "Export destination",
					lines: [
						`Configured: ${destination.configuredPath}`,
						`Resolves here to: ${destination.resolvedPath}`,
						"Submit an empty value to reset to PLAN.md. Changes affect the next export.",
					],
					placeholder: configured,
					action: "set-export",
					hint: "back",
				};
			},
		},
		actions: {
			"open-export": async () => ({ kind: "to", screen: "export" }),
			"set-export": async ({ ctx: actionCtx, value, signal }) => {
				const defaultPlanExportPath = value?.trim() || null;
				const result = await savePatch(
					actionCtx,
					{ defaultPlanExportPath },
					signal,
					defaultPlanExportPath
						? `Default Plan export destination: ${safeTerminalText(defaultPlanExportPath)}.`
						: "Default Plan export destination reset to PLAN.md.",
				);
				return result.kind === "stay" ? { kind: "to", screen: "settings" } : result;
			},
		},
	});

	return runMenu(ctx, menu, {
		getState: loadState,
		signal: options.signal,
		isCurrent: options.isCurrent,
	});

	async function savePatch(
		actionCtx: ExtensionContext,
		patch: PlanModeSettingsPatch,
		signal: AbortSignal,
		successMessage: string,
	) {
		if (signal.aborted || !options.isCurrent()) return { kind: "rejected" as const };
		try {
			const saved = await updateSettings(patch, { settingsPath: options.settingsPath, signal });
			if (options.isCurrent()) options.onSaved(saved);
			if (signal.aborted || !options.isCurrent()) return { kind: "rejected" as const };
			actionCtx.ui.notify(successMessage, "info");
			return { kind: "stay" as const };
		} catch (error) {
			if (!signal.aborted && options.isCurrent()) {
				actionCtx.ui.notify(
					`Could not save Plan mode settings; the previous value remains: ${safeTerminalText(formatError(error))}`,
					"error",
				);
			}
			return { kind: "rejected" as const };
		}
	}
}

function settingsLines(settingsPath: string) {
	return [
		`User settings · ${safeTerminalText(settingsPath)}`,
		"The export destination applies to its next action.",
	];
}

function invalidScreen(settingsPath: string, state: SettingsMenuState) {
	return {
		kind: "detail" as const,
		title: "Plan Mode Settings · Read only",
		lines: [
			`Invalid settings file. Fix ${safeTerminalText(settingsPath)} before saving.`,
			safeTerminalText(state.reason ?? "The settings file is invalid."),
		],
		hint: "back" as const,
	};
}

function safeTerminalText(value: string) {
	return [...value]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
		})
		.join("")
		.trim();
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
