import { randomUUID } from "node:crypto";

import type { AppServerConfig } from "../config/app-server-config.ts";
import { appServerLogger } from "../logging/app-server-logger.ts";
import { JsonRpcConnection } from "../protocol/json-rpc-connection.ts";
import { StdioTransport } from "../transports/stdio-transport.ts";
import { createAppServer } from "./create-app-server.ts";

export const runStdioAppServer = async (
  config: AppServerConfig
): Promise<void> => {
  const appServer = await createAppServer(config);
  const stdioTransport = new StdioTransport();
  const connection = new JsonRpcConnection({
    clientId: `stdio-${randomUUID()}`,
    logger: appServerLogger,
    transport: stdioTransport,
  });
  appServer.register(connection);

  const shutdown = (): void => {
    connection.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await connection.run();
  } finally {
    appServer.close();
  }
};
