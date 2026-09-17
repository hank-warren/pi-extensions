import type { AppServerConfig } from "../config/app-server-config.ts";
import { appServerLogger } from "../logging/app-server-logger.ts";
import { PiLiveSessionManager } from "../pi/live-session-manager.ts";
import { PiModelCatalog } from "../pi/model-catalog.ts";
import { ThreadConnections } from "../pi/thread-connections.ts";
import { PiModelRuntime } from "../pi/pi-model-runtime.ts";
import { PiSessionRepository } from "../pi/session-repository.ts";
import { PiThreadCatalog } from "../pi/thread-catalog.ts";
import { MetadataDatabase } from "../storage/metadata-database.ts";
import { AppServer } from "./app-server.ts";

export const createAppServer = async (
  config: AppServerConfig
): Promise<AppServer> => {
  const database = new MetadataDatabase(config.paths.database);
  const piModelRuntime = await PiModelRuntime.create(config);
  // Start loading Pi's extensions now, but do not block the server on it: the
  // relay connects and clients attach while it runs, and anything that reads the
  // model catalogue awaits it. See PiModelRuntime.loadExtensions.
  void piModelRuntime.loadExtensions({ logger: appServerLogger });
  const modelCatalog = new PiModelCatalog(piModelRuntime, config.models);
  const threadConnections = new ThreadConnections();
  const sessionRepository = new PiSessionRepository(database);
  const threadCatalog = new PiThreadCatalog({
    database,
    sessionRepository,
  });
  const liveSessionManager = new PiLiveSessionManager({
    modelCatalog,
    threadConnections,
    modelRuntime: piModelRuntime,
    sessionRepository,
    threadCatalog,
  });
  return new AppServer({
    config,
    threadConnections,
    database,
    liveSessionManager,
    modelCatalog,
    modelRuntime: piModelRuntime,
    sessionRepository,
    threadCatalog,
  });
};
