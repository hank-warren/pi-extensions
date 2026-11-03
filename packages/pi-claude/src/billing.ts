/**
 * Guards against requests silently moving from Claude plan limits to
 * pay-as-you-go usage credits (formerly "extra usage"). There is deliberately
 * no override: this provider only ever draws on plan limits.
 */

/** Claude Code's `rate_limit_event.rate_limit_info`, as far as this extension relies on it. */
export interface RateLimitInfo {
  status?: string;
  rateLimitType?: string;
  resetsAt?: number;
  isUsingOverage?: boolean;
  overageStatus?: string;
  overageDisabledReason?: string;
  [key: string]: unknown;
}

// Every message we produce contains "billing" so Pi's retry classifier treats
// it as a non-retryable account error.
const USAGE_CREDITS_REJECTION =
  /third-party apps now draw from your extra usage|out of extra usage|draws? from your usage credits|usage credits/iu;

export function usageCreditsChargeError(info: RateLimitInfo): Error {
  return new Error(
    "Claude subscription billing: this response was charged to Claude usage credits instead of your plan limits " +
      `(rate limit status ${info.status ?? "unknown"}${info.rateLimitType ? `, ${info.rateLimitType}` : ""}). ` +
      "Pi stopped so no further requests are charged. To stay on plan limits only, turn off usage credits at " +
      "claude.ai/settings/usage.",
  );
}

/** Rewrite an Anthropic usage-credit rejection into an actionable, non-retryable error. */
export function describeUsageCreditsRejection(message: string): string | undefined {
  if (!USAGE_CREDITS_REJECTION.test(message)) return undefined;
  return (
    "Claude subscription billing: Anthropic did not accept this request on your Claude plan limits and wants to " +
    "charge it to usage credits. This happens when your plan limit is used up, or when Anthropic classifies the " +
    "request as third-party app usage. Pi will not retry it. Original error: " +
    message
  );
}
