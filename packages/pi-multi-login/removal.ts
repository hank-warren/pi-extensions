/**
 * Alias removal, ordered so a failure can never leave a half-removed alias
 * that comes back on restart.
 *
 * The order is the whole point:
 *
 * 1. **Config first.** It is the only restart-stable record, so a failed write
 *    must be a complete no-op — nothing live has been touched yet.
 * 2. **Live registries next.** They are session state; a failure here is
 *    recoverable by restarting Pi and is reported as such.
 * 3. **Credential last**, because deleting it is destructive and irreversible.
 *    A failure leaves an orphaned auth slot, which is inert, rather than a
 *    credential-less alias the user can still select.
 */

import { type AliasEntry, aliasEntryId } from "./config.js";

type NotifyLevel = "info" | "warning" | "error";

export interface AliasRemovalSteps {
	/** Persist the remaining aliases; throwing aborts the removal entirely. */
	saveConfig(remaining: AliasEntry[]): void;
	/** Drop the provider from the shared credential runtime. */
	unregisterRuntimeProvider(id: string): void;
	/** Drop the provider from this Pi session. */
	unregisterSessionProvider(id: string): void;
	/** Delete the stored credential. */
	logout(id: string): Promise<void>;
	notify(message: string, level: NotifyLevel): void;
}

type AliasRemovalOutcome =
	| "not-configured"
	| "config-failed"
	| "removed"
	| "removed-credential-orphaned";

interface AliasRemovalResult {
	outcome: AliasRemovalOutcome;
	/** The alias list to adopt; unchanged unless the config write succeeded. */
	aliases: AliasEntry[];
	restartRequired: boolean;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function removeAliasEntry(
	id: string,
	aliases: readonly AliasEntry[],
	configPath: string,
	steps: AliasRemovalSteps,
): Promise<AliasRemovalResult> {
	const remaining = aliases.filter((candidate) => aliasEntryId(candidate) !== id);
	if (remaining.length === aliases.length) {
		steps.notify(`${id} is already removed.`, "info");
		return { outcome: "not-configured", aliases: [...aliases], restartRequired: false };
	}

	try {
		steps.saveConfig(remaining);
	} catch (error) {
		steps.notify(`Could not write ${configPath}: ${errorMessage(error)}`, "error");
		return { outcome: "config-failed", aliases: [...aliases], restartRequired: false };
	}

	let restartRequired = false;
	try {
		steps.unregisterRuntimeProvider(id);
	} catch (error) {
		restartRequired = true;
		steps.notify(
			`Could not unregister ${id} from the credential runtime: ${errorMessage(error)}. Restart Pi to finish removal.`,
			"warning",
		);
	}
	try {
		steps.unregisterSessionProvider(id);
	} catch (error) {
		restartRequired = true;
		steps.notify(
			`Could not unregister ${id} from this session: ${errorMessage(error)}. Restart Pi to finish removal.`,
			"warning",
		);
	}

	try {
		await steps.logout(id);
	} catch (error) {
		steps.notify(
			`Removed ${id}, but could not delete its credential: ${errorMessage(error)}. Run /logout for that provider or remove the stale credential later.`,
			"warning",
		);
		return { outcome: "removed-credential-orphaned", aliases: remaining, restartRequired };
	}

	steps.notify(
		`Removed ${id}${restartRequired ? "; restart Pi to clear the live provider" : ""}.`,
		restartRequired ? "warning" : "info",
	);
	return { outcome: "removed", aliases: remaining, restartRequired };
}
