import { completeSimple } from "@earendil-works/pi-ai/compat";

/**
 * Model dispatch seam for extension-issued background model calls.
 *
 * pi-ai's `compat.completeSimple` dispatches through pi-ai's own api registry,
 * which extension-registered provider transports never reach: pi routes
 * `pi.registerProvider()` configs only through the coding agent's
 * `ModelRuntime` -> `provider-composer.streamWith`. Auth-shaping extensions
 * such as `@gotgenes/pi-anthropic-auth` install their transport wrapper there,
 * so a request issued via `compat.completeSimple` reaches Anthropic unshaped,
 * and Claude Pro/Max OAuth requests fail with the misleading "extra usage"
 * HTTP 400 (see gotgenes/pi-anthropic-auth docs/architecture.md, "The
 * remaining gap: pi-ai compat dispatch").
 *
 * `ExtensionContext.modelRegistry` is a deliberately narrowed facade over
 * `ModelRuntime` that re-exports `complete()` but not `completeSimple()` —
 * and only the simple layer translates the api-agnostic `reasoning` option
 * into each api's native thinking config. So reach the runtime's
 * `completeSimple` through the facade's `runtime` field (a public JS field
 * marked `private` in the .d.ts), and fall back to compat dispatch when a
 * future pi release renames the seam — degrading to the historical behavior
 * instead of crashing.
 *
 * This file was duplicated verbatim into packages/pi-herdr-auto-title until
 * that package was removed; `DUPLICATED_SOURCES` in `scripts/validate.py`
 * policed the copies. It has one home again. If a second extension package
 * ever needs it, copy it rather than importing across packages by relative
 * path, and register the pair in `DUPLICATED_SOURCES` — which is why every
 * package-specific detail stays behind a parameter (`packageLabel`).
 * The "guardian" in the names is historical: pi-auto-permissions' guardian
 * reviewer was the first caller.
 */
type GuardianCompleteSimple = typeof completeSimple;

let warnedCompatFallback = false;

export function resolveGuardianCompleteSimple(
  modelRegistry: unknown,
  packageLabel: string,
): GuardianCompleteSimple {
  const runtime = (modelRegistry as { runtime?: unknown } | null | undefined)?.runtime;
  const candidate = (runtime as { completeSimple?: unknown } | null | undefined)?.completeSimple;
  if (typeof candidate === "function") {
    return candidate.bind(runtime) as GuardianCompleteSimple;
  }
  if (!warnedCompatFallback) {
    warnedCompatFallback = true;
    console.warn(
      `[${packageLabel}] host ModelRuntime completeSimple is unavailable; falling back to pi-ai compat dispatch. Extension-registered provider transports (e.g. Anthropic OAuth shaping) will not apply to this extension's model calls.`,
    );
  }
  return completeSimple;
}
