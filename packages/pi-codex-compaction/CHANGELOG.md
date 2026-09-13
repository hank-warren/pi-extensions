# @hank-warren/pi-codex-compaction

## 0.1.0

### Minor Changes

- Initial publication of the MIT-licensed fork of `@ogulcancelik/pi-codex-compaction` 0.1.5, retaining upstream attribution and direct Codex checkpoint compatibility.
- Add native encrypted compaction through CLIProxyAPI for GPT-5.6 and GPT-6 families while keeping the provider on `openai-responses`. Use the configured proxy endpoint, resolved API key, custom headers, and `remote_compaction_v2` feature header; CPA continues to manage upstream OAuth.
- Integrate with Pi's manual, context-threshold, and overflow compaction lifecycle. Support repeated compaction, session resume, and cancellation, with the upstream compatibility guard retained for Pi versions before 0.84.4.
- Preserve finalized system/developer instructions when replay replaces Responses history. Bind CPA checkpoints to the provider, model, and normalized endpoint, and fail closed rather than silently falling back to a text summary.
- Add global-only `cpaProviders` configuration for renamed CPA providers or disabling CPA support. The default is `["cpa"]`; unrelated providers and unsupported model families are not opted in.
- Verify two-account failover on CLIProxyAPI v7.2.157 with GPT-6 Astra: after an injected quota-exceeded response, the replacement account can compact the original account's encrypted reasoning, replay its native checkpoint, and re-compact it while retaining a synthetic fact. CPA owns account selection; no upstream account pinning is added.
