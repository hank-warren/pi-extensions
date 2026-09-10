import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { ProviderCatalog } from "./catalog.ts";
import { ProviderRuntime } from "./runtime.ts";
import { buildProviderRegistration } from "./registration.ts";
import { buildUnavailableProviderModels } from "./provider.ts";
import { registerCliproxyapiCommand } from "./commands.ts";
import { getDiscoveryApiKey } from "./auth.ts";
import { loadProviderSettings } from "./settings.ts";
import { registerCodexCompatiblePayloadAdapter } from "./codex-compat.ts";

export default async function (pi: ExtensionAPI) {
  let config = DEFAULT_CONFIG;
  try {
    const cwd = process.cwd();
    config = loadConfig(cwd);
    const settings = loadProviderSettings(cwd);
    const catalog = new ProviderCatalog({
      config,
      gpt56ContextWindow: settings.gpt56ContextWindow,
      getApiKey: () => getDiscoveryApiKey(config.providerName),
    });
    const runtime = new ProviderRuntime({ pi, config, catalog });
    registerCodexCompatiblePayloadAdapter(pi, config.providerName);
    registerCliproxyapiCommand(pi, runtime, catalog);
    await runtime.start();
  } catch (error) {
    registerCodexCompatiblePayloadAdapter(pi, config.providerName);
    registerCliproxyapiCommand(pi);
    pi.registerProvider(config.providerName, buildProviderRegistration(config, buildUnavailableProviderModels()).config);
    console.warn(`[pi-cliproxyapi-provider] registered placeholder provider after startup failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}
