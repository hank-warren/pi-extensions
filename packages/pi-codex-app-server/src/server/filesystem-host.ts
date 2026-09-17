import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { JSONRPCErrorException } from "json-rpc-2.0";

import type { JsonRpcConnection } from "../protocol/json-rpc-connection.ts";
import { invalidParams } from "../protocol/request-error.ts";
import type { FsCreateDirectoryParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/FsCreateDirectoryParams.js";
import type { FsGetMetadataParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/FsGetMetadataParams.js";
import type { FsReadDirectoryEntry } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/FsReadDirectoryEntry.js";
import type { FsReadDirectoryParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/FsReadDirectoryParams.js";
import type { FsReadFileParams } from "../../vendor/openai-codex-app-server-protocol/typescript/v2/FsReadFileParams.js";

/**
 * A ceiling on `fs/readFile`, which answers in a single base64 response and so
 * has to fit in one message.
 */
const MAX_READ_BYTES = 8 * 1024 * 1024;

const requireAbsolute = (path: string): string => {
  if (!isAbsolute(path)) {
    throw invalidParams(`path must be absolute: ${path}`);
  }
  return path;
};

/**
 * Translate a filesystem failure into a JSON-RPC error.
 *
 * The client distinguishes "not there" from "not allowed" in its own UI, so the
 * message has to survive the trip rather than becoming a generic failure.
 */
const asRequestError = (error: unknown, path: string): Error => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") {
    return invalidParams(`no such path: ${path}`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return invalidParams(`permission denied: ${path}`);
  }
  if (code === "ENOTDIR") {
    return invalidParams(`not a directory: ${path}`);
  }
  return invalidParams(
    error instanceof Error ? error.message : `cannot access ${path}`
  );
};

/**
 * Resolve what a directory entry actually is, following symlinks.
 *
 * `readdir` reports a symlink as neither file nor directory, which would hide
 * every symlinked project directory from the app's folder picker. A link whose
 * target is missing falls back to the link's own type rather than failing the
 * whole listing.
 */
const describeEntry = async (
  directory: string,
  entry: Dirent
): Promise<FsReadDirectoryEntry> => {
  if (!entry.isSymbolicLink()) {
    return {
      fileName: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    };
  }
  let target: Stats | undefined;
  try {
    target = await stat(join(directory, entry.name));
  } catch {
    target = undefined;
  }
  return {
    fileName: entry.name,
    isDirectory: target?.isDirectory() ?? false,
    isFile: target?.isFile() ?? false,
  };
};

/**
 * Answer the filesystem questions a client asks about its host.
 *
 * The ChatGPT app browses directories to let someone pick a working folder, and
 * the neutral stub these replaced returned an empty listing for every path:
 * the picker showed nothing, offered no way forward, and a folder could only be
 * reached if it was already in the recent list. These are the read and
 * directory-creation methods the picker uses; mutating methods (`fs/writeFile`,
 * `fs/remove`, `fs/copy`) stay unimplemented deliberately, since nothing
 * observed asks for them and a remote client should not get them for free.
 */
export const registerFilesystemHost = (connection: JsonRpcConnection): void => {
  connection.registerRequest(
    "fs/readDirectory",
    async (params: FsReadDirectoryParams) => {
      const path = requireAbsolute(params.path);
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch (error) {
        throw asRequestError(error, path);
      }
      return {
        entries: await Promise.all(
          entries.map((entry) => describeEntry(path, entry))
        ),
      };
    }
  );

  connection.registerRequest(
    "fs/getMetadata",
    async (params: FsGetMetadataParams) => {
      const path = requireAbsolute(params.path);
      try {
        // lstat() answers whether the path is itself a link; stat() answers
        // what it points at, so a symlinked directory still reports as a
        // directory. A broken link falls back to its own stats rather than
        // failing the request.
        const link = await lstat(path);
        const target = link.isSymbolicLink()
          ? await stat(path).catch(() => link)
          : link;
        return {
          createdAtMs: Math.floor(target.birthtimeMs),
          isDirectory: target.isDirectory(),
          isFile: target.isFile(),
          isSymlink: link.isSymbolicLink(),
          modifiedAtMs: Math.floor(target.mtimeMs),
        };
      } catch (error) {
        throw asRequestError(error, path);
      }
    }
  );

  connection.registerRequest(
    "fs/createDirectory",
    async (params: FsCreateDirectoryParams) => {
      const path = requireAbsolute(params.path);
      try {
        await mkdir(path, { recursive: params.recursive ?? true });
      } catch (error) {
        throw asRequestError(error, path);
      }
      return {};
    }
  );

  connection.registerRequest(
    "fs/readFile",
    async (params: FsReadFileParams) => {
      const path = requireAbsolute(params.path);
      try {
        const info = await stat(path);
        if (info.size > MAX_READ_BYTES) {
          throw invalidParams(
            `file is too large to read in one response: ${path}`
          );
        }
        return { dataBase64: (await readFile(path)).toString("base64") };
      } catch (error) {
        throw error instanceof JSONRPCErrorException
          ? error
          : asRequestError(error, path);
      }
    }
  );
};
