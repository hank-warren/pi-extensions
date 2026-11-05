import {
  getSelectListTheme,
  getSettingsListTheme,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { SettingsList } from "@earendil-works/pi-tui";
import {
  APPROVAL_MODES,
  autoPermissionsConfigPath,
  loadAutoPermissionsConfig,
  type ApprovalMode,
  type AutoPermissionsConfig,
} from "./config.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { patchAutoPermissionsConfig } from "./config-writer.js";
import { readRecentDenials } from "./denial-log.js";
import type { GuardianReviewer } from "./guardian-reviewer.js";
import type { SessionOverrides } from "./session-overrides.js";
import {
  applySettingChange,
  buildSettingItems,
  createDenialsSubmenu,
  createModelSubmenu,
  createTimeoutSubmenu,
  type DenialsSubmenuHost,
  type DenialSummary,
  type MenuModel,
  type ReviewerSettings,
  type SettingChange,
  type SubmenuHost,
} from "./settings-menu.js";

/**
 * What `/auto-permissions setup` says on the user's behalf. Named after the
 * bundled skill rather than a `/skill:` invocation, because skill commands can
 * be turned off in settings while the skill itself stays discoverable.
 */
const SETUP_SKILL_HANDOFF_MESSAGE =
  "Use the auto-permissions-setup skill to set up my Auto Permissions policy.";

/** What each `/auto-permissions <mode>` confirms. */
const MODE_NOTICES: Record<ApprovalMode, string> = {
  auto: "Auto Permissions: auto — commands the guardian can't approve are blocked and the agent keeps working; you're prompted only after repeated blocks.",
  careful: "Auto Permissions: careful — you're prompted as soon as the guardian can't approve a command.",
  afk: "Auto Permissions: afk — nothing prompts; blocked commands are listed in the agent's final message. /auto-permissions auto when you're back.",
};

export interface ApprovalModeControl {
  /** Switch this session's mode; returns why it cannot, or undefined. */
  set(mode: ApprovalMode, ctx: ExtensionContext): string | undefined;
}

export function registerSettingsCommand(
  pi: ExtensionAPI,
  { overrides, reviewer, approvalMode }: {
    overrides: SessionOverrides;
    reviewer: GuardianReviewer;
    approvalMode: ApprovalModeControl;
  },
): void {
  /**
   * `/auto-permissions`: edit the reviewer model, thinking level, timeout,
   * parallel reviews and the enabled flag without hand-editing config.json.
   *
   * There is no live-apply step: every tool call re-reads the config through
   * currentConfig(), so a saved edit is in force immediately -- in this session
   * and in every other one. reviewerFingerprint() covers provider, model and
   * reasoning effort, so the cached reviewer lineage self-invalidates too.
   *
   * `/auto-permissions setup` is a pointer, not a wizard: it hands the job to
   * the bundled auto-permissions-setup skill. A conversational setup can ask
   * about an ambiguous host, weigh history-wide friction and back out of a bad
   * suggestion; a fixed accept-or-discard draft could do none of that, so the
   * two paths were never equal and keeping both only split the maintenance.
   */
  pi.registerCommand("auto-permissions", {
    description: "Configure Auto Permissions; auto | careful | afk switch this session's approval mode; setup hands off to the auto-permissions-setup skill",
    getArgumentCompletions: (prefix: string) =>
      [...APPROVAL_MODES, "setup"]
        .filter((value) => value.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      if ((APPROVAL_MODES as readonly string[]).includes(arg)) {
        const mode = arg as ApprovalMode;
        const refused = approvalMode.set(mode, ctx);
        ctx.ui.notify(refused ? `Auto Permissions: ${refused}` : MODE_NOTICES[mode], refused ? "warning" : "info");
        return;
      }
      if (arg === "setup") {
        // Dispatch rather than instruct: the point of the pointer is that the
        // interview starts on this keystroke.
        pi.sendUserMessage(SETUP_SKILL_HANDOFF_MESSAGE);
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/auto-permissions requires interactive TUI mode", "warning");
        return;
      }

      const path = autoPermissionsConfigPath();
      let settings: ReviewerSettings;
      let denialLog: AutoPermissionsConfig["denialLog"];
      try {
        const config = loadAutoPermissionsConfig(path);
        settings = {
          enabled: config.enabled,
          reviewer: config.reviewer,
          reviewConcurrency: config.reviewConcurrency,
          systemPromptSource: config.systemPromptSource,
        };
        denialLog = config.denialLog;
      } catch (error) {
        // Editing a file we cannot validate is the one way this writer could
        // quietly make things worse, so refuse rather than open.
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Auto Permissions config error: ${message} \u2014 fix ${path} first`, "warning");
        return;
      }

      /** Persist one accepted edit, then report anything the save surfaced. */
      const commit = (change: SettingChange): void => {
        if (change.kind === "ignored") return;
        if (change.kind === "error") {
          ctx.ui.notify(change.message, "warning");
          return;
        }
        const previous = settings;
        settings = change.settings;
        try {
          patchAutoPermissionsConfig(path, {
            enabled: settings.enabled,
            reviewer: settings.reviewer,
            // Only when this edit changed it, so a hand-written value is never rewritten by an unrelated save.
            ...(settings.reviewConcurrency !== previous.reviewConcurrency
              ? { reviewConcurrency: settings.reviewConcurrency }
              : {}),
          });
        } catch (error) {
          settings = previous;
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Could not save Auto Permissions settings: ${message}`, "warning");
          return;
        }
        if (change.kind === "warn") ctx.ui.notify(change.message, "warning");
        // A breakage elsewhere in the file would otherwise surface at the next
        // bash call, looking like this edit caused it.
        try {
          loadAutoPermissionsConfig(path);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Auto Permissions config error: ${message}`, "warning");
        }
      };

      const reviewerModel = (): MenuModel | undefined => {
        if (!settings.reviewer) return undefined;
        return ctx.modelRegistry.find(settings.reviewer.provider, settings.reviewer.model) as MenuModel | undefined;
      };

      const recentDenials = (): DenialSummary[] => {
        if (!denialLog.enabled) return [];
        try {
          return readRecentDenials(denialLog.path, 20).map((record) => ({
            id: record.id,
            ts: record.ts,
            gateLabel: record.gate.label,
            command: record.command,
            verdict: record.reviseFirst ? "revise first" : record.verdict,
            reason: record.reason,
          }));
        } catch {
          return [];
        }
      };

      /**
       * Closes the settings dialog. Assigned when `ctx.ui.custom` builds the
       * component, so it is only ever called from inside the dialog it closes.
       */
      let closeSettings: (() => void) | undefined;

      /**
       * "Allow on retry": the existing override machinery, driven from the
       * denial ledger. An exact-command allow override (which already
       * generalizes correctly and survives via evidence re-injection and the
       * session entry), plus a visible injected message telling the agent it
       * may retry. No new authorization pathway.
       *
       * The dialog is closed *before* the message is dispatched, and the order
       * is load-bearing. The retry hits the same gate, so the approval prompt
       * opens another `ctx.ui.custom` — stacked on a still-open settings
       * dialog, that orphans this one: it stops rendering but keeps consuming
       * editor input, and the composer never submits again. Observed live
       * twice; the only escape was restarting pi.
       */
      const allowRetry = (denial: DenialSummary): void => {
        closeSettings?.();
        overrides.allowRetry(denial, reviewer.lastEvidenceKey);
        ctx.ui.notify("Override added for the exact command; the agent may retry it.", "info");
      };

      await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
        closeSettings = () => done(undefined);
        const host: SubmenuHost = {
          getSettings: () => settings,
          commit,
          availableModels: () => ctx.modelRegistry.getAvailable() as MenuModel[],
          requestRender: () => tui.requestRender(),
          settingsTheme: getSettingsListTheme(),
          selectTheme: getSelectListTheme(),
        };
        const denialsHost: DenialsSubmenuHost = {
          recentDenials,
          allowRetry,
          settingsTheme: getSettingsListTheme(),
          selectTheme: getSelectListTheme(),
          requestRender: () => tui.requestRender(),
        };
        const list = new SettingsList(
          buildSettingItems(
            settings,
            {
              reviewerModel: createModelSubmenu(host),
              timeout: createTimeoutSubmenu(host),
              ...(denialLog.enabled ? { recentDenials: createDenialsSubmenu(denialsHost) } : {}),
            },
            undefined,
            denialLog.enabled ? recentDenials().length : undefined,
          ),
          10,
          host.settingsTheme,
          (id, value) => {
            commit(applySettingChange(settings, id, value, reviewerModel()));
            tui.requestRender();
          },
          () => done(undefined),
          { enableSearch: true },
        );
        return {
          invalidate(): void {
            list.invalidate();
          },
          handleInput(data: string): void {
            list.handleInput(data);
          },
          render(width: number): string[] {
            return list.render(width);
          },
        };
      });
    },
  });
}
