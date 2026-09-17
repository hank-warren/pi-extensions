import { z } from "zod";

import { ensureAppServerDirectories } from "../config/app-server-config.ts";
import type { AppServerConfig } from "../config/app-server-config.ts";
import { PiModelRuntime } from "../pi/pi-model-runtime.ts";
import { MetadataDatabase } from "../storage/metadata-database.ts";
import { loadOrEnroll } from "./enrollment.ts";
import { loadRemoteControlAuth } from "./remote-control-auth.ts";
import { resolveRemoteControlEndpoints } from "./remote-control-endpoints.ts";

const pairingResponseSchema = z.object({
  environment_id: z.string().min(1),
  expires_at: z.iso.datetime(),
  manual_pairing_code: z.string().nullable(),
  pairing_code: z.string().min(1),
  server_id: z.string().min(1),
});

export interface PairingResult {
  readonly environmentId: string;
  readonly expiresAt: string;
  readonly manualPairingCode: string | null;
  readonly pairingCode: string;
}

export const startRemoteControlPairing = async (
  config: AppServerConfig
): Promise<PairingResult> => {
  await ensureAppServerDirectories(config);
  const database = new MetadataDatabase(config.paths.database);
  try {
    const piModelRuntime = await PiModelRuntime.create(config);
    const remoteAuth = await loadRemoteControlAuth(piModelRuntime);
    const remoteEndpoints = resolveRemoteControlEndpoints(
      config.remoteControl.baseUrl
    );
    const enrollment = await loadOrEnroll({
      auth: remoteAuth,
      config,
      database,
      endpoints: remoteEndpoints,
    });
    const httpResponse = await fetch(remoteEndpoints.pairUrl, {
      body: JSON.stringify({ manual_code: true }),
      headers: {
        Authorization: `Bearer ${enrollment.remoteControlToken}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    if (!httpResponse.ok) {
      throw new Error(
        `Remote Control pairing failed: HTTP ${httpResponse.status}`
      );
    }
    const pairing = pairingResponseSchema.parse(await httpResponse.json());
    if (
      pairing.server_id !== enrollment.serverId ||
      pairing.environment_id !== enrollment.environmentId
    ) {
      throw new Error(
        "Remote Control pairing returned a mismatched enrollment"
      );
    }
    return {
      environmentId: pairing.environment_id,
      expiresAt: pairing.expires_at,
      manualPairingCode: pairing.manual_pairing_code,
      pairingCode: pairing.pairing_code,
    };
  } finally {
    database.close();
  }
};
