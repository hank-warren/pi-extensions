/**
 * Codex models are reached over a websocket session rather than plain HTTP, and
 * the guardian has to pick that transport itself. The check is on the model's
 * api rather than its provider id so it keeps working for a reviewer pointed at
 * an aliased Codex login (see @hank-warren/pi-multi-login).
 */
export function isOpenAICodexModel(model: { api?: string }): boolean {
  return model.api === "openai-codex-responses";
}
