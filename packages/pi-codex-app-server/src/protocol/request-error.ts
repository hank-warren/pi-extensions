import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";

/**
 * Reject a request whose arguments cannot be acted on.
 *
 * The code has to reach the client, and only the library's own exception type
 * carries it: anything else is reported as a generic internal error with code
 * `0`, which tells a client nothing about whether retrying could help.
 */
export const invalidParams = (message: string): JSONRPCErrorException =>
  new JSONRPCErrorException(message, JSONRPCErrorCode.InvalidParams);
